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

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new Error("Enter a valid YouTube URL.");
  if (!counts.includes(clipCount) || !lengths.includes(clipLength)) throw new Error("Invalid clip options.");

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
    source_url: sourceUrl,
    clip_count: clipCount,
    clip_length: clipLength,
    status: "queued"
  });

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function signOut() {
  await routeSupabase().auth.signOut();
  redirect("/login");
}
