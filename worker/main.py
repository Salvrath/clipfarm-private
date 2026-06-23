import os
import re
import shutil
import subprocess
import tempfile
import traceback
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel
from supabase import create_client
from yt_dlp import YoutubeDL

try:
    from faster_whisper import WhisperModel
except ImportError:  # pragma: no cover
    WhisperModel = None

app = FastAPI(title="ClipFarm worker")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
WORKER_SHARED_SECRET = os.environ["WORKER_SHARED_SECRET"]
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "clips")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

class JobRequest(BaseModel):
    job_id: str

@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}

@app.post("/jobs")
def enqueue_job(payload: JobRequest, background_tasks: BackgroundTasks, x_worker_secret: str = Header(default="")) -> dict[str, str]:
    print("POST /jobs received", flush=True)
    print(f"job_id received: {payload.job_id}", flush=True)
    if x_worker_secret != WORKER_SHARED_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")
    background_tasks.add_task(process_job, payload.job_id)
    return {"status": "queued", "job_id": payload.job_id}

def process_job(job_id: str) -> None:
    with tempfile.TemporaryDirectory(prefix="clipfarm-") as tmp:
        workdir = Path(tmp)
        try:
            job = supabase.table("jobs").select("*").eq("id", job_id).single().execute().data
            print(f"job loaded from Supabase: {job_id}", flush=True)
            supabase.table("jobs").update({"status": "processing", "error_message": None}).eq("id", job_id).execute()
            print(f"status updated to processing: {job_id}", flush=True)
            print(f"download started: {job_id}", flush=True)
            source = download_video(job["source_url"], workdir)
            print(f"download completed: {job_id} -> {source.name}", flush=True)
            print(f"transcription started: {job_id}", flush=True)
            transcript = transcribe(source)
            print(f"transcription completed: {job_id}; segments={len(transcript)}", flush=True)
            starts = score_highlights(transcript, int(job["clip_count"]), int(job["clip_length"]))
            print(f"clips selected: {job_id}; starts={starts}", flush=True)
            assets = render_clips(source, starts, int(job["clip_length"]), transcript, workdir, job_id)
            source.unlink(missing_ok=True)
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
            supabase.table("jobs").update({"status": "complete", "assets": assets, "expires_at": expires_at}).eq("id", job_id).execute()
            print(f"job completed: {job_id}", flush=True)
        except Exception as exc:  # noqa: BLE001 - persist worker failures to the job record
            print(f"exception while processing job {job_id}: {exc}", flush=True)
            print(traceback.format_exc(), flush=True)
            supabase.table("jobs").update({"status": "failed", "error_message": str(exc)}).eq("id", job_id).execute()
            raise

def download_video(url: str, workdir: Path) -> Path:
    output = workdir / "source.%(ext)s"
    with YoutubeDL({"outtmpl": str(output), "format": "bv*+ba/b", "merge_output_format": "mp4", "noplaylist": True}) as ydl:
        ydl.download([url])
    matches = list(workdir.glob("source.*"))
    if not matches:
        raise RuntimeError("yt-dlp did not produce a source video")
    return matches[0]

def transcribe(video_path: Path) -> list[dict[str, Any]]:
    if WhisperModel is None:
        return [{"start": 0.0, "end": 60.0, "text": "Transcript unavailable. Generated fallback clip."}]
    model = WhisperModel(WHISPER_MODEL, device=os.getenv("WHISPER_DEVICE", "cpu"), compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "int8"))
    segments, _ = model.transcribe(str(video_path), vad_filter=True, word_timestamps=False)
    return [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segments]

def score_highlights(transcript: list[dict[str, Any]], count: int, length: int) -> list[float]:
    excitement = re.compile(r"\b(wow|insane|crazy|amazing|unbelievable|clutch|no way|finally|best|huge)\b", re.I)
    candidates = []
    for segment in transcript:
        words = segment["text"].split()
        score = len(words) + 20 * len(excitement.findall(segment["text"])) + segment["text"].count("!") * 10
        start = max(0.0, float(segment["start"]) - 4.0)
        candidates.append((score, start))
    candidates.sort(reverse=True)
    starts: list[float] = []
    for _, start in candidates:
        if all(abs(start - existing) >= length for existing in starts):
            starts.append(start)
        if len(starts) == count:
            break
    while len(starts) < count:
        starts.append(float(len(starts) * length * 2))
    return sorted(starts)

def render_clips(source: Path, starts: list[float], length: int, transcript: list[dict[str, Any]], workdir: Path, job_id: str) -> list[dict[str, str]]:
    clip_paths: list[Path] = []
    for index, start in enumerate(starts, start=1):
        subtitle = workdir / f"clip-{index}.srt"
        write_srt(subtitle, transcript, start, length)
        output = workdir / f"clip-{index}.mp4"
        vf = f"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles={subtitle.name}:force_style='Alignment=2,Fontsize=18,Outline=2'"
        print(f"clip render started: job={job_id} clip={index} start={start} length={length}", flush=True)
        subprocess.run(["ffmpeg", "-y", "-ss", str(start), "-i", str(source), "-t", str(length), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", str(output)], cwd=workdir, check=True)
        print(f"clip render completed: job={job_id} clip={index} output={output.name}", flush=True)
        clip_paths.append(output)
    zip_path = workdir / "clipfarm-clips.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for clip in clip_paths:
            archive.write(clip, arcname=clip.name)
    assets = []
    for clip in clip_paths:
        path = f"{job_id}/{clip.name}"
        print(f"upload started: job={job_id} path={path}", flush=True)
        upload(path, clip, "video/mp4")
        print(f"upload completed: job={job_id} path={path}", flush=True)
        assets.append({"path": path, "kind": "clip"})
    zip_storage_path = f"{job_id}/{zip_path.name}"
    print(f"upload started: job={job_id} path={zip_storage_path}", flush=True)
    upload(zip_storage_path, zip_path, "application/zip")
    print(f"upload completed: job={job_id} path={zip_storage_path}", flush=True)
    assets.append({"path": zip_storage_path, "kind": "zip"})
    return assets

def write_srt(path: Path, transcript: list[dict[str, Any]], clip_start: float, length: int) -> None:
    lines = []
    index = 1
    for segment in transcript:
        start = float(segment["start"]) - clip_start
        end = float(segment["end"]) - clip_start
        if end <= 0 or start >= length:
            continue
        lines.extend([str(index), f"{srt_time(max(0, start))} --> {srt_time(min(length, end))}", segment["text"], ""])
        index += 1
    if not lines:
        lines = ["1", f"00:00:00,000 --> 00:00:{min(length, 10):02d},000", "ClipFarm highlight", ""]
    path.write_text("\n".join(lines), encoding="utf-8")

def srt_time(seconds: float) -> str:
    millis = int((seconds % 1) * 1000)
    total = int(seconds)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d},{millis:03d}"

def upload(path: str, local_path: Path, content_type: str) -> None:
    with local_path.open("rb") as file_obj:
        supabase.storage.from_(SUPABASE_STORAGE_BUCKET).upload(path, file_obj, {"content-type": content_type, "upsert": "true"})

def cleanup_expired() -> dict[str, int]:
    expired = supabase.table("jobs").select("id, assets").lt("expires_at", datetime.now(timezone.utc).isoformat()).execute().data
    removed = 0
    for job in expired:
        paths = [asset["path"] for asset in job.get("assets") or []]
        if paths:
            supabase.storage.from_(SUPABASE_STORAGE_BUCKET).remove(paths)
            removed += len(paths)
        supabase.table("jobs").update({"assets": [], "expires_at": None}).eq("id", job["id"]).execute()
    return {"removed": removed}
