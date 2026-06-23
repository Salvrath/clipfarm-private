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

  const workerUrl = process.env.WORKER_URL?.trim();
  const workerSecret = process.env.WORKER_SHARED_SECRET?.trim();

  if (!workerUrl || !workerSecret) {
    const missing = [
      !workerUrl ? "WORKER_URL" : null,
      !workerSecret ? "WORKER_SHARED_SECRET" : null
    ].filter(Boolean).join(", ");
    const message = `Missing worker environment variable(s): ${missing}`;

    await supabase.from("jobs").update({
      status: "failed",
      error_message: message
    }).eq("id", job.id);

    revalidatePath("/dashboard");
    throw new Error(message);
  }

  const endpoint = `${workerUrl.replace(/\/$/, "")}/jobs`;
  console.log("Worker endpoint used:", endpoint);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": workerSecret
      },
      body: JSON.stringify({ job_id: job.id })
    });
  } catch (err) {
    const thrownMessage = err instanceof Error ? err.message : String(err);
    const message = `Worker fetch failed. Endpoint: ${endpoint}. Error: ${thrownMessage}`;

    await supabase.from("jobs").update({
      status: "failed",
      error_message: message
    }).eq("id", job.id);

    revalidatePath("/dashboard");
    throw new Error(message);
  }

  if (!response.ok) {
    const body = await response.text();
    const truncatedBody = body.slice(0, 1000);
    const message = `Worker rejected job. Endpoint: ${endpoint}. Status: ${response.status}. Body: ${truncatedBody}`;
    console.error("Worker rejected job", { endpoint, status: response.status, body: truncatedBody });

    await supabase.from("jobs").update({
      status: "failed",
      error_message: message
    }).eq("id", job.id);

    revalidatePath("/dashboard");
    throw new Error(`Worker rejected job. Endpoint: ${endpoint}. Status: ${response.status}`);
  }

  console.log(`Worker accepted job ${job.id} at ${endpoint}`);
  revalidatePath("/dashboard");
}

export async function signOut() {
  await routeSupabase().auth.signOut();
  redirect("/login");
}
