# ClipFarm

ClipFarm is a private web app for turning a YouTube URL into short vertical clips with burned-in captions. Processing is fully cloud-based: the browser submits a job, GitHub Actions runs Whisper/FFmpeg, and finished clips are stored privately in Supabase for 24 hours.

## Architecture

1. Next.js on Vercel creates a `queued` job in Supabase.
2. A scheduled GitHub Actions workflow runs every five minutes.
3. The workflow authenticates to a Supabase Edge Function with GitHub OIDC. No permanent service-role key is stored in GitHub.
4. The GitHub-hosted runner downloads the source with yt-dlp, transcribes it with faster-whisper, selects highlights, renders 9:16 MP4 files with FFmpeg, and uploads through short-lived signed upload tokens.
5. The dashboard creates signed download links using the signed-in user's Supabase session and RLS.
6. The worker deletes expired Storage objects after 24 hours.

## Cloud resources

- Supabase project: `urlrvkkobtvpuefbpowe` (`eu-north-1`)
- Edge Function: `clipfarm-worker`
- Storage bucket: `clips` (private)
- Worker: `.github/workflows/clipfarm-worker.yml`

## Vercel environment

The frontend only needs the public Supabase values:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://urlrvkkobtvpuefbpowe.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase publishable key>
```

`SUPABASE_SERVICE_ROLE_KEY`, `WORKER_URL`, and `WORKER_SHARED_SECRET` are no longer required by Vercel.

## GitHub Actions security

The workflow requests a short-lived GitHub OIDC token with audience `clipfarm-supabase`. The Supabase Edge Function verifies issuer, audience, repository ID, owner ID, workflow ref, branch, and that the runner is GitHub-hosted before allowing jobs to be claimed or updated.

No GitHub Actions repository secret is required for Supabase access.

## Worker dependencies

The runner installs yt-dlp 2026.6.9, bgutil-ytdlp-pot-provider 1.3.1, faster-whisper 1.2.1, FFmpeg, Node.js 24, and supabase-py 2.31.0.

## Usage

1. Create a private Supabase Auth user in the ClipFarm project.
2. Set the two public Supabase variables on the Vercel project.
3. Deploy `main`.
4. Sign in at `/login`.
5. Paste a YouTube URL, choose 3/5/10 clips and 30/45/60 seconds, then queue the job.
6. Refresh the dashboard after the worker starts. Finished clips and a ZIP appear as download links.

The scheduled worker can take up to roughly five minutes to pick up a newly queued job before processing starts.

## Rights

Use ClipFarm only with videos you own or have permission to download, edit, and republish. YouTube and source-content rights still apply even though the processing tools are cloud-hosted.
