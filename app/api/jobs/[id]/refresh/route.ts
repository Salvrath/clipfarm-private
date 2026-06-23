import { adminSupabase, routeSupabase, type ClipAsset } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  const auth = routeSupabase();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = adminSupabase();
  const { data: job, error } = await supabase.from("jobs").select("*").eq("id", params.id).eq("user_id", user.id).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "clips";
  const assets = await Promise.all(((job.assets || []) as ClipAsset[]).map(async (asset) => {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(asset.path, 60 * 60);
    return { ...asset, signedUrl: data?.signedUrl };
  }));
  return NextResponse.json({ ...job, assets });
}
