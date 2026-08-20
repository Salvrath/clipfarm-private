"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import * as tus from "tus-js-client";
import { failUpload, finalizeUpload, prepareUpload } from "./actions";

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export default function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [clipCount, setClipCount] = useState("3");
  const [clipLength, setClipLength] = useState("45");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const supabase = useMemo(
    () => createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    ),
    [],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setStatus("Video is larger than the 1 GB upload limit.");
      return;
    }

    setBusy(true);
    setProgress(0);
    setStatus("Preparing upload…");
    let jobId: string | null = null;

    try {
      const formData = new FormData();
      formData.set("file_name", file.name);
      formData.set("file_size", String(file.size));
      formData.set("clip_count", clipCount);
      formData.set("clip_length", clipLength);

      const prepared = await prepareUpload(formData);
      jobId = prepared.jobId;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Your login session has expired.");

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
      const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
      const endpoint = `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`;

      setStatus("Uploading video…");

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(file, {
          endpoint,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          headers: {
            authorization: `Bearer ${session.access_token}`,
            apikey: publishableKey,
          },
          uploadDataDuringCreation: true,
          removeFingerprintOnSuccess: true,
          chunkSize: 6 * 1024 * 1024,
          metadata: {
            bucketName: "sources",
            objectName: prepared.sourcePath,
            contentType: prepared.contentType,
            cacheControl: "3600",
          },
          onError(error) {
            reject(error);
          },
          onProgress(bytesUploaded, bytesTotal) {
            setProgress(bytesTotal ? Math.round((bytesUploaded / bytesTotal) * 100) : 0);
          },
          onSuccess() {
            resolve();
          },
        });

        upload.start();
      });

      setProgress(100);
      setStatus("Upload complete. Queueing cloud processing…");
      await finalizeUpload(jobId);
      setStatus("Queued. Cloud processing starts automatically.");
      setFile(null);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upload error";
      setStatus(message);
      if (jobId) {
        try {
          await failUpload(jobId, message);
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
          The video goes directly from your browser to private cloud storage. MP4, MOV, WebM and MKV are supported up to 1 GB.
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

      {file && (
        <p className="upload-meta">
          {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
        </p>
      )}

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
