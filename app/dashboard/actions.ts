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

  if (process.env.WORKER_URL && process.env.WORKER_SHARED_SECRET) {
    await fetch(`${process.env.WORKER_URL}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SHARED_SECRET },
      body: JSON.stringify({ job_id: job.id })
    }).catch(console.error);
  }
  revalidatePath("/dashboard");
}

export async function signOut() {
  await routeSupabase().auth.signOut();
  redirect("/login");
}
