import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export type ClipAsset = { path: string; signedUrl?: string; kind: "clip" | "zip" };
export type ClipJob = {
  id: string;
  user_id: string;
  source_url: string;
  clip_count: 3 | 5 | 10;
  clip_length: 30 | 45 | 60;
  status: "queued" | "processing" | "complete" | "failed";
  error_message: string | null;
  assets: ClipAsset[] | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

export function serverSupabase() {
  const cookieStore = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: Record<string, unknown>) { cookieStore.set({ name, value, ...options }); },
      remove(name: string, options: Record<string, unknown>) { cookieStore.set({ name, value: "", ...options }); }
    }
  });
}

export const routeSupabase = serverSupabase;

export function adminSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin environment variables");
  return createClient(url, key, { auth: { persistSession: false } });
}
