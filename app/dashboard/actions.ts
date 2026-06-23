"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { routeSupabase, serverSupabase } from "@/lib/supabaseServer";

const counts = [3, 5, 10];
const lengths = [30, 45, 60];

export async function createJob(formData: FormData) {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sourceUrl = String(formData.get("source_url") || "").trim();
  const clipCount = Number(formData.get("clip_count"));
  const clipLength = Number(formData.get("clip_length"));
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new Error("Enter a valid YouTube or Twitch URL.");
  if (!counts.includes(clipCount) || !lengths.includes(clipLength)) throw new Error("Invalid clip options.");

  const { data: job, error } = await supabase.from("jobs").insert({
    user_id: user.id,
    source_url: sourceUrl,
    clip_count: clipCount,
    clip_length: clipLength,
    status: "queued"
  }).select("id").single();
  if (error) throw new Error(error.message);

  const workerUrl = process.env.WORKER_URL;
  const workerSecret = process.env.WORKER_SHARED_SECRET;

  if (!workerUrl || !workerSecret) {
    const message = "ClipFarm worker is not configured. Set WORKER_URL and WORKER_SHARED_SECRET.";
    await markJobFailed(supabase, job.id, message);
    revalidatePath("/dashboard");
    throw new Error(message);
  }
  
console.log("Worker URL used:", process.env.WORKER_URL);
  
  let response: Response;
  try {
    response = await fetch(`${workerUrl}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": workerSecret
      },
      body: JSON.stringify({ job_id: job.id })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker request failure";
    await markJobFailed(supabase, job.id, `Worker request failed: ${message}`);
    revalidatePath("/dashboard");
    throw new Error(`Worker request failed: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text();
    const message = `Worker rejected job with status ${response.status}: ${body}`;
    console.error("Worker rejected ClipFarm job", { status: response.status, body });
    await markJobFailed(supabase, job.id, message);
    revalidatePath("/dashboard");
    throw new Error(message);
  }

  console.log(`Worker accepted ClipFarm job ${job.id}`);
  revalidatePath("/dashboard");
}

async function markJobFailed(supabase: ReturnType<typeof serverSupabase>, jobId: string, errorMessage: string) {
  const { error } = await supabase.from("jobs").update({ status: "failed", error_message: errorMessage }).eq("id", jobId);
  if (error) throw new Error(`Failed to update job after worker error: ${error.message}`);
}

export async function signOut() {
  await routeSupabase().auth.signOut();
  redirect("/login");
}
