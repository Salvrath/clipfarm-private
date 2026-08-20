"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { failUpload, finalizeUpload, prepareUpload } from "./actions";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const RETRY_DELAYS = [0, 1500, 4000];

type SignedPart = { partNumber: number; url: string };
type CompletedPart = { partNumber: number; etag: string };

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadPart(url: string, body: Blob) {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    const delay = RETRY_DELAYS[attempt];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      const response = await fetch(url, { method: "PUT", body });
      if (!response.ok) throw new Error(`R2 upload returned HTTP ${response.status}.`);
      const etag = response.headers.get("etag");
      if (!etag) {
        throw new Error("R2 did not expose an ETag header. Check the bucket CORS policy.");
      }
      return etag;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown R2 upload error.");
    }
  }
  throw lastError || new Error("R2 upload failed.");
}

export default function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [clipCount, setClipCount] = useState("3");
  const [clipLength, setClipLength] = useState("45");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus("Video is larger than the 5 GB upload limit.");
      return;
    }

    setBusy(true);
    setProgress(0);
    setStatus("Preparing secure R2 upload…");
    let jobId: string | null = null;
    let uploadId: string | null = null;

    try {
      const formData = new FormData();
      formData.set("file_name", file.name);
      formData.set("file_size", String(file.size));
      formData.set("clip_count", clipCount);
      formData.set("clip_length", clipLength);

      const prepared = await prepareUpload(formData);
      jobId = prepared.jobId;
      uploadId = prepared.uploadId;
      const signedParts = prepared.parts as SignedPart[];
      const completedParts: CompletedPart[] = new Array(signedParts.length);
      let nextIndex = 0;
      let uploadedBytes = 0;

      setStatus(`Uploading ${signedParts.length} parts directly to R2…`);

      async function uploader() {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= signedParts.length) return;

          const part = signedParts[index];
          const start = (part.partNumber - 1) * prepared.partSize;
          const end = Math.min(start + prepared.partSize, file.size);
          const blob = file.slice(start, end);
          const etag = await uploadPart(part.url, blob);
          completedParts[index] = { partNumber: part.partNumber, etag };
          uploadedBytes += blob.size;
          setProgress(Math.min(100, Math.round((uploadedBytes / file.size) * 100)));
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, signedParts.length) },
          () => uploader(),
        ),
      );

      setProgress(100);
      setStatus("Upload complete. Finalizing multipart file…");
      await finalizeUpload(jobId, uploadId, completedParts);
      setStatus("Queued. Cloud processing starts automatically.");
      setFile(null);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upload error";
      setStatus(message);
      if (jobId && uploadId) {
        try {
          await failUpload(jobId, uploadId, message);
        } catch {
          // The original upload error is more useful to the user.
        }
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <h2>Upload a video</h2>
        <p>
          The video goes directly from your browser to private Cloudflare R2 storage. MP4, MOV, WebM and MKV are supported up to 5 GB.
        </p>
      </div>

      <label>
        Video file
        <input
          type="file"
          accept=".mp4,.mov,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska"
          disabled={busy}
          required
          onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            setProgress(0);
            setStatus("");
          }}
        />
      </label>

      <div className="form-grid">
        <label>
          Number of clips
          <select value={clipCount} disabled={busy} onChange={(event) => setClipCount(event.target.value)}>
            <option>3</option>
            <option>5</option>
            <option>10</option>
          </select>
        </label>
        <label>
          Clip length
          <select value={clipLength} disabled={busy} onChange={(event) => setClipLength(event.target.value)}>
            <option value="30">30s</option>
            <option value="45">45s</option>
            <option value="60">60s</option>
          </select>
        </label>
      </div>

      {file && <p className="upload-meta">{file.name} · {formatFileSize(file.size)}</p>}

      {(busy || progress > 0) && (
        <div className="progress-track" aria-label={`Upload ${progress}%`}>
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}

      {status && <p className="upload-status">{status}</p>}
      <button type="submit" disabled={!file || busy}>
        {busy ? `Uploading ${progress}%` : "Upload and create clips"}
      </button>
    </form>
  );
}
