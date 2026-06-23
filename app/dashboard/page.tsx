import { redirect } from "next/navigation";
import { createJob, signOut } from "./actions";
import { adminSupabase, type ClipAsset, type ClipJob, serverSupabase } from "@/lib/supabaseServer";
import RefreshButton from "./refreshButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await supabase.from("jobs").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(25);
  const jobs = await signJobAssets((data || []) as ClipJob[]);

  return (
    <main className="container">
      <div className="topbar">
        <div><h2>ClipFarm dashboard</h2><p>Submit one VOD at a time for the simplest private workflow.</p></div>
        <form action={signOut}><button className="secondary">Sign out</button></form>
      </div>
      <section className="card grid">
        <form action={createJob}>
          <label>Video URL<input name="source_url" placeholder="https://www.youtube.com/watch?v=... or Twitch VOD URL" required /></label>
          <div className="form-grid">
            <label>Number of clips<select name="clip_count" defaultValue="3"><option>3</option><option>5</option><option>10</option></select></label>
            <label>Clip length<select name="clip_length" defaultValue="45"><option value="30">30s</option><option value="45">45s</option><option value="60">60s</option></select></label>
          </div>
          <button>Submit job</button>
        </form>
      </section>
      <section className="card" style={{ marginTop: 24 }}>
        <div className="topbar"><h2>Jobs</h2><RefreshButton /></div>
        {jobs.length === 0 && <p>No jobs yet.</p>}
        {jobs.map((job) => <JobCard key={job.id} job={job} />)}
      </section>
    </main>
  );
}

function JobCard({ job }: { job: ClipJob }) {
  const assets = job.assets || [];
  return (
    <article className="job">
      <div className={`status ${job.status}`}>{job.status}</div>
      <strong>{job.clip_count} clips · {job.clip_length}s</strong>
      <p style={{ overflowWrap: "anywhere" }}>{job.source_url}</p>
      {job.error_message && <p className="error">{job.error_message}</p>}
      {job.expires_at && <p>Files expire: {new Date(job.expires_at).toLocaleString()}</p>}
      <div className="downloads">
        {assets.map((asset, index) => asset.signedUrl ? <a className="button secondary" key={asset.path} href={asset.signedUrl}>Download {asset.kind === "zip" ? "ZIP" : `clip ${index + 1}`}</a> : null)}
      </div>
    </article>
  );
}

async function signJobAssets(jobs: ClipJob[]): Promise<ClipJob[]> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return jobs;
  const admin = adminSupabase();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "clips";
  return Promise.all(jobs.map(async (job) => ({
    ...job,
    assets: await Promise.all(((job.assets || []) as ClipAsset[]).map(async (asset) => {
      const { data } = await admin.storage.from(bucket).createSignedUrl(asset.path, 60 * 60);
      return { ...asset, signedUrl: data?.signedUrl };
    }))
  })));
}
