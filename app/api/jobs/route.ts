import { adminSupabase } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (request.headers.get("x-worker-secret") !== process.env.WORKER_SHARED_SECRET) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json();
  const supabase = adminSupabase();
  const { data, error } = await supabase.from("jobs").select("*").eq("id", body.job_id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ job: data, storage_bucket: process.env.SUPABASE_STORAGE_BUCKET || "clips" });
}
