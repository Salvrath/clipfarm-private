import { redirect } from "next/navigation";
import { signOut } from "./actions";
import UploadForm from "./uploadForm";
import { type ClipAsset, type ClipJob, serverSupabase } from "@/lib/supabaseServer";
import RefreshButton from "./refreshButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = serverSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("jobs")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(25);

  const jobs = await signJobAssets(supabase, (data || []) as ClipJob[]);

  return (
    <main className="container">
      <div className="topbar">
        <div>
          <h2>ClipFarm dashboard</h2>
          <p>Upload a video. ClipFarm finds highlights, makes vertical clips and burns in captions in the cloud.</p>
        </div>
        <form action={signOut}><button className="secondary">Sign out</button></form>
      </div>

      <section className="card grid">
        <UploadForm />
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
  const sourceLabel = job.source_type === "upload"
    ? (job.source_name || "Uploaded video")
    : (job.source_url || "YouTube video");

  return (
    <article className="job">
      <div className={`status ${job.status}`}>{job.status}</div>
      <strong>{job.clip_count} clips · {job.clip_length}s</strong>
      <p style={{ overflowWrap: "anywhere" }}>{sourceLabel}</p>
      {job.status === "uploading" && <p>Video upload has not finished yet.</p>}
      {job.status === "queued" && <p>Waiting for the next cloud-worker run.</p>}
      {job.status === "processing" && <p>Transcribing and rendering clips.</p>}
      {job.error_message && <p className="error">{job.error_message}</p>}
      {job.expires_at && <p>Files expire: {new Date(job.expires_at).toLocaleString()}</p>}
      <div className="downloads">
        {assets.map((asset, index) => asset.signedUrl ? (
          <a className="button secondary" key={asset.path} href={asset.signedUrl}>
            Download {asset.kind === "zip" ? "ZIP" : `clip ${index + 1}`}
          </a>
        ) : null)}
      </div>
    </article>
  );
}

async function signJobAssets(
  supabase: ReturnType<typeof serverSupabase>,
  jobs: ClipJob[]
): Promise<ClipJob[]> {
  return Promise.all(jobs.map(async (job) => ({
    ...job,
    assets: await Promise.all(((job.assets || []) as ClipAsset[]).map(async (asset) => {
      const { data } = await supabase.storage.from("clips").createSignedUrl(asset.path, 60 * 60);
      return { ...asset, signedUrl: data?.signedUrl };
    }))
  })));
}
