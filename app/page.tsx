import Link from "next/link";
import { serverSupabase } from "@/lib/supabaseServer";

export default async function HomePage() {
  const supabase = serverSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  return (
    <main className="container">
      <section className="hero">
        <p>Private MVP</p>
        <h1>ClipFarm turns long VODs into captioned vertical clips.</h1>
        <p>Paste a YouTube or Twitch VOD URL, pick how many clips you want, and download MP4s or a ZIP when the worker finishes.</p>
        <div>
          <Link className="button" href={session ? "/dashboard" : "/login"}>{session ? "Open dashboard" : "Private login"}</Link>
        </div>
      </section>
    </main>
  );
}
