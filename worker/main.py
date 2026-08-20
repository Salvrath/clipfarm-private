import json
import os
import re
import shlex
import subprocess
import tempfile
import traceback
import zipfile
from pathlib import Path
from typing import Any

import requests
from faster_whisper import WhisperModel
from supabase import create_client

EDGE_FUNCTION_URL = os.environ["EDGE_FUNCTION_URL"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_PUBLISHABLE_KEY = os.environ["SUPABASE_PUBLISHABLE_KEY"]
GITHUB_OIDC_TOKEN = os.environ["GITHUB_OIDC_TOKEN"]
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
REQUEST_TIMEOUT = 60


def call_edge(action: str, **payload: Any) -> dict[str, Any]:
    response = requests.post(
        EDGE_FUNCTION_URL,
        headers={
            "authorization": f"Bearer {GITHUB_OIDC_TOKEN}",
            "content-type": "application/json",
        },
        json={"action": action, **payload},
        timeout=REQUEST_TIMEOUT,
    )
    if not response.ok:
        raise RuntimeError(f"Worker gateway {action} failed ({response.status_code}): {response.text[:1200]}")
    return response.json()


def main() -> None:
    try:
        cleanup = call_edge("cleanup")
        print(f"Expired assets removed: {cleanup.get('removed', 0)}", flush=True)
    except Exception as cleanup_exc:  # noqa: BLE001
        print(f"Cleanup warning: {cleanup_exc}", flush=True)

    requested_job = os.getenv("CLIPFARM_JOB_ID", "").strip() or None
    claim = call_edge("claim", **({"job_id": requested_job} if requested_job else {}))
    job = claim.get("job")
    if not job:
        print("No queued ClipFarm job found.", flush=True)
        return

    job_id = str(job["id"])
    print(f"Claimed job {job_id}", flush=True)

    try:
        process_job(job)
    except Exception as exc:  # noqa: BLE001
        message = f"{type(exc).__name__}: {exc}"
        print(message, flush=True)
        print(traceback.format_exc(), flush=True)
        try:
            call_edge("fail", job_id=job_id, error=message[:4000])
        except Exception as report_exc:  # noqa: BLE001
            print(f"Could not report failure: {report_exc}", flush=True)
        raise


def process_job(job: dict[str, Any]) -> None:
    job_id = str(job["id"])
    clip_count = int(job["clip_count"])
    clip_length = int(job["clip_length"])

    with tempfile.TemporaryDirectory(prefix="clipfarm-") as tmp:
        workdir = Path(tmp)
        source = download_video(str(job["source_url"]), workdir)
        transcript = transcribe(source)
        starts = score_highlights(transcript, clip_count, clip_length)
        files = render_clips(source, starts, clip_length, transcript, workdir)

        zip_path = workdir / "clipfarm-clips.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for clip in files:
                archive.write(clip, arcname=clip.name)

        upload_files = files + [zip_path]
        storage_paths = [f"{job_id}/{path.name}" for path in upload_files]
        signed = call_edge("upload_urls", job_id=job_id, paths=storage_paths)
        upload_tokens = {item["path"]: item["token"] for item in signed.get("uploads", [])}

        storage = create_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY).storage.from_("clips")
        assets: list[dict[str, str]] = []
        for local_path, storage_path in zip(upload_files, storage_paths, strict=True):
            token = upload_tokens.get(storage_path)
            if not token:
                raise RuntimeError(f"Missing signed upload token for {storage_path}")
            with local_path.open("rb") as file_obj:
                storage.upload_to_signed_url(path=storage_path, token=token, file=file_obj)
            assets.append({"path": storage_path, "kind": "zip" if local_path.suffix == ".zip" else "clip"})
            print(f"Uploaded {storage_path}", flush=True)

        call_edge("complete", job_id=job_id, assets=assets)
        print(f"Completed job {job_id}", flush=True)


def download_video(url: str, workdir: Path) -> Path:
    output = workdir / "source.%(ext)s"
    command = [
        "yt-dlp",
        "--no-playlist",
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--socket-timeout",
        "30",
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=mweb",
        "--format",
        "bv*[height<=720]+ba/b[height<=720]/best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "--output",
        str(output),
        url,
    ]
    print(f"yt-dlp: {shlex.join(command)}", flush=True)
    result = subprocess.run(command, cwd=workdir, text=True, capture_output=True)
    if result.returncode != 0:
        error_text = "\n".join(part for part in [result.stdout, result.stderr] if part).strip()
        raise RuntimeError(error_text[:3000] or "yt-dlp failed")

    matches = sorted(workdir.glob("source.*"))
    if not matches:
        raise RuntimeError("yt-dlp did not produce a source video")
    return matches[0]


def transcribe(video_path: Path) -> list[dict[str, Any]]:
    model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    segments, _ = model.transcribe(str(video_path), vad_filter=True, word_timestamps=False)
    transcript = [
        {"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    if not transcript:
        raise RuntimeError("Whisper returned an empty transcript")
    return transcript


def score_highlights(transcript: list[dict[str, Any]], count: int, length: int) -> list[float]:
    hook_words = re.compile(
        r"\b(wow|insane|crazy|amazing|unbelievable|secret|mistake|best|worst|never|always|finally|huge|why|how|what|here's|this is)\b",
        re.I,
    )
    candidates: list[tuple[float, float]] = []
    for index, segment in enumerate(transcript):
        text = str(segment["text"])
        words = text.split()
        duration = max(0.1, float(segment["end"]) - float(segment["start"]))
        density = min(len(words) / duration, 4.0)
        score = len(words) + 14 * len(hook_words.findall(text)) + 8 * text.count("!") + 2 * density
        if index == 0:
            score *= 0.8
        start = max(0.0, float(segment["start"]) - 2.5)
        candidates.append((score, start))

    candidates.sort(reverse=True)
    starts: list[float] = []
    for _, start in candidates:
        if all(abs(start - existing) >= max(15, length * 0.8) for existing in starts):
            starts.append(start)
        if len(starts) >= count:
            break

    if len(starts) < count:
        max_end = max(float(item["end"]) for item in transcript)
        spacing = max(length, max_end / max(count, 1))
        cursor = 0.0
        while len(starts) < count and cursor < max_end:
            if all(abs(cursor - existing) >= max(15, length * 0.8) for existing in starts):
                starts.append(cursor)
            cursor += spacing

    return sorted(starts[:count])


def render_clips(
    source: Path,
    starts: list[float],
    length: int,
    transcript: list[dict[str, Any]],
    workdir: Path,
) -> list[Path]:
    clips: list[Path] = []
    for index, start in enumerate(starts, start=1):
        subtitle = workdir / f"clip-{index}.srt"
        write_srt(subtitle, transcript, start, length)
        output = workdir / f"clip-{index}.mp4"
        vf = (
            "scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,"
            f"subtitles={subtitle.name}:force_style='Alignment=2,Fontsize=18,Outline=2,MarginV=110'"
        )
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            str(start),
            "-i",
            str(source),
            "-t",
            str(length),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(output),
        ]
        subprocess.run(command, cwd=workdir, check=True)
        clips.append(output)
        print(f"Rendered {output.name} ({start:.1f}s)", flush=True)
    return clips


def write_srt(path: Path, transcript: list[dict[str, Any]], clip_start: float, length: int) -> None:
    lines: list[str] = []
    counter = 1
    for segment in transcript:
        start = float(segment["start"]) - clip_start
        end = float(segment["end"]) - clip_start
        if end <= 0 or start >= length:
            continue
        lines.extend(
            [
                str(counter),
                f"{srt_time(max(0, start))} --> {srt_time(min(length, end))}",
                str(segment["text"]),
                "",
            ]
        )
        counter += 1
    path.write_text("\n".join(lines), encoding="utf-8")


def srt_time(seconds: float) -> str:
    millis = int(round((seconds % 1) * 1000))
    total = int(seconds)
    if millis == 1000:
        total += 1
        millis = 0
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d},{millis:03d}"


if __name__ == "__main__":
    main()
