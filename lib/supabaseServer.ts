import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export type ClipAsset = { path: string; signedUrl?: string; kind: "clip" | "zip" };
export type ClipJob = {
  id: string;
  user_id: string;
  source_type: "youtube" | "upload";
  source_url: string | null;
  source_path: string | null;
  source_name: string | null;
  clip_count: 3 | 5 | 10;
  clip_length: 30 | 45 | 60;
  status: "uploading" | "queued" | "processing" | "complete" | "failed";
  error_message: string | null;
  assets: ClipAsset[] | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

export function serverSupabase() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot write cookies. middleware.ts refreshes
            // the session before rendering and persists refreshed cookies.
          }
        },
      },
    },
  );
}

export const routeSupabase = serverSupabase;
