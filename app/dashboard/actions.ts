"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routeSupabase, serverSupabase } from "@/lib/supabaseServer";

const counts = [3, 5, 10];
const lengths = [30, 45, 60];
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const uploadTypes: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

function validateClipOptions(clipCount: number, clipLength: number) {
  if (!counts.includes(clipCount) || !lengths.includes(clipLength)) {
    throw new Error("Invalid clip options.");
  }
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
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES) {
    throw new Error("Video must be between 1 byte and 1 GB.");
  }

  const jobId = randomUUID();
  const sourcePath = `${jobId}/source.${extension}`;

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
  return { jobId, sourcePath, contentType };
}

export async function finalizeUpload(jobId: string) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "queued", error_message: null })
    .eq("id", jobId)
    .eq("user_id", user.id)
    .eq("source_type", "upload")
    .eq("status", "uploading")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Upload job could not be queued.");

  revalidatePath("/dashboard");
}

export async function failUpload(jobId: string, message: string) {
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
    await supabase.storage.from("sources").remove([job.source_path]);
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
