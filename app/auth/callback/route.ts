import { routeSupabase } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) await routeSupabase().auth.exchangeCodeForSession(code);
  return NextResponse.redirect(new URL("/dashboard", request.url));
}
