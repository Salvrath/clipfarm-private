"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  R2_MAX_UPLOAD_BYTES,
  R2_PART_SIZE,
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  createPartUploadUrls,
  deleteR2Object,
} from "@/lib/r2";
import { routeSupabase, serverSupabase } from "@/lib/supabaseServer";

const counts = [3, 5, 10];
const lengths = [30, 45, 60];
const uploadTypes: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

type UploadedPart = { partNumber: number; etag: string };

function validateClipOptions(clipCount: number, clipLength: number) {
  if (!counts.includes(clipCount) || !lengths.includes(clipLength)) {
    throw new Error("Invalid clip options.");
  }
}

function normalizeCompletedParts(parts: UploadedPart[]) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 10_000) {
    throw new Error("Invalid multipart upload result.");
  }

  const normalized = parts.map((part) => {
    const partNumber = Number(part?.partNumber);
    const etag = String(part?.etag || "").trim();
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !etag || etag.length > 256) {
      throw new Error("Invalid uploaded part metadata.");
    }
    return { PartNumber: partNumber, ETag: etag };
  }).sort((a, b) => Number(a.PartNumber) - Number(b.PartNumber));

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].PartNumber !== index + 1) {
      throw new Error("Multipart upload is missing one or more parts.");
    }
  }
  return normalized;
}

export async function prepareUpload(formData: FormData) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const fileName = String(formData.get("file_name") || "").trim();
  const fileSize = Number(formData.get("file_size"));
  const clipCount = Number(formData.get("clip_count"));
  const clipLength = Number(formData.get("clip_length"));
  validateClipOptions(clipCount, clipLength);

  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  const contentType = uploadTypes[extension];
  if (!contentType) throw new Error("Use MP4, MOV, WebM or MKV.");
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > R2_MAX_UPLOAD_BYTES) {
    throw new Error("Video must be between 1 byte and 5 GB.");
  }

  const partCount = Math.ceil(fileSize / R2_PART_SIZE);
  const jobId = randomUUID();
  const sourcePath = `${jobId}/source.${extension}`;
  let uploadId = "";

  try {
    uploadId = await createMultipartUpload(sourcePath, contentType);
    const parts = await createPartUploadUrls(sourcePath, uploadId, partCount);

    const { error } = await supabase.from("jobs").insert({
      id: jobId,
      user_id: user.id,
      source_type: "upload",
      source_url: null,
      source_path: sourcePath,
      source_name: fileName.slice(0, 200),
      clip_count: clipCount,
      clip_length: clipLength,
      status: "uploading",
    });
    if (error) throw new Error(error.message);

    revalidatePath("/dashboard");
    return { jobId, uploadId, sourcePath, partSize: R2_PART_SIZE, parts };
  } catch (error) {
    if (uploadId) {
      try {
        await abortMultipartUpload(sourcePath, uploadId);
      } catch {
        // R2 auto-aborts incomplete multipart uploads after seven days.
      }
    }
    throw error;
  }
}

export async function finalizeUpload(jobId: string, uploadId: string, parts: UploadedPart[]) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("source_path,status")
    .eq("id", jobId)
    .eq("user_id", user.id)
    .eq("source_type", "upload")
    .maybeSingle();

  if (jobError) throw new Error(jobError.message);
  if (!job?.source_path || job.status !== "uploading") throw new Error("Upload job is no longer active.");

  const completedParts = normalizeCompletedParts(parts);
  await completeMultipartUpload(job.source_path, uploadId, completedParts);

  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "queued", error_message: null })
    .eq("id", jobId)
    .eq("user_id", user.id)
    .eq("source_type", "upload")
    .eq("status", "uploading")
    .select("id")
    .maybeSingle();

  if (error || !data) {
    try {
      await deleteR2Object(job.source_path);
    } catch {
      // Preserve the database error below.
    }
    throw new Error(error?.message || "Upload job could not be queued.");
  }

  revalidatePath("/dashboard");
}

export async function failUpload(jobId: string, uploadId: string, message: string) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: job } = await supabase
    .from("jobs")
    .select("source_path")
    .eq("id", jobId)
    .eq("user_id", user.id)
    .eq("source_type", "upload")
    .maybeSingle();

  if (job?.source_path) {
    await Promise.allSettled([
      abortMultipartUpload(job.source_path, uploadId),
      deleteR2Object(job.source_path),
    ]);
  }

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      error_message: `Upload failed: ${message}`.slice(0, 1000),
    })
    .eq("id", jobId)
    .eq("user_id", user.id)
    .eq("source_type", "upload")
    .eq("status", "uploading");

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function createJob(formData: FormData) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sourceUrl = String(formData.get("source_url") || "").trim();
  const clipCount = Number(formData.get("clip_count"));
  const clipLength = Number(formData.get("clip_length"));
  validateClipOptions(clipCount, clipLength);

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new Error("Enter a valid YouTube URL.");

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Enter a valid YouTube URL.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["youtube.com", "youtu.be", "m.youtube.com"].includes(hostname)) {
    throw new Error("ClipFarm currently accepts YouTube URLs only.");
  }

  const { error } = await supabase.from("jobs").insert({
    user_id: user.id,
    source_type: "youtube",
    source_url: sourceUrl,
    clip_count: clipCount,
    clip_length: clipLength,
    status: "queued",
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function signOut() {
  await routeSupabase().auth.signOut();
  redirect("/login");
}
