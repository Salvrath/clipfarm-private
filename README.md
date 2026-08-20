# ClipFarm

ClipFarm is a private web app for turning uploaded videos into short vertical clips with burned-in captions. Large source videos are uploaded directly from the browser to private Cloudflare R2 storage. Processing remains fully cloud-based: GitHub Actions runs Whisper/FFmpeg, finished clips are stored privately in Supabase for 24 hours, and the R2 source object is deleted after processing.

## Architecture

1. Next.js on Vercel creates an `uploading` job in Supabase and starts an R2 multipart upload.
2. The browser uploads the source directly to Cloudflare R2 with short-lived presigned part URLs. Video data does not pass through Vercel or Supabase Storage.
3. When the multipart upload completes, the job changes to `queued`.
4. A scheduled GitHub Actions workflow runs every five minutes and authenticates to the Supabase Edge Function with GitHub OIDC.
5. For uploaded sources, the GitHub-hosted runner downloads the private object from R2 using scoped R2 credentials. It then runs faster-whisper and FFmpeg, uploads finished clips to the private Supabase `clips` bucket, and deletes the R2 source object.
6. The dashboard creates signed download links for the finished clips using the signed-in user's Supabase session and RLS.
7. Finished Supabase clip assets expire after 24 hours.

The older YouTube downloader remains in the worker as a secondary backend path, but direct video upload is the primary ClipFarm flow.

## Cloud resources

- Supabase project: `urlrvkkobtvpuefbpowe` (`eu-north-1`)
- Supabase Edge Function: `clipfarm-worker`
- Supabase output bucket: `clips` (private)
- Cloudflare R2 source bucket: `clipfarm-sources` (private)
- Worker: `.github/workflows/clipfarm-worker.yml`

## Cloudflare R2 setup

Create a private R2 bucket named `clipfarm-sources`, then create an R2 API token with Object Read & Write permission limited to that bucket.

The bucket needs CORS so the browser can PUT presigned multipart parts and read each part's ETag:

```json
[
  {
    "AllowedOrigins": ["https://clipfarm-private.vercel.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Keep the bucket private. The browser only receives temporary presigned URLs for the exact multipart parts it is allowed to upload.

## Vercel environment

Set these variables on the Vercel project for Production and Preview:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://urlrvkkobtvpuefbpowe.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase publishable key>
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_ACCESS_KEY_ID=<R2 access key ID>
R2_SECRET_ACCESS_KEY=<R2 secret access key>
R2_BUCKET=clipfarm-sources
```

The three R2 credential values are server-only and must never be exposed through `NEXT_PUBLIC_*` variables.

## GitHub Actions secrets

Add these repository secrets:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

The workflow uses the same private `clipfarm-sources` bucket. Supabase access still uses short-lived GitHub OIDC, so no Supabase service-role key is stored in GitHub.

## Upload behavior

- Supported source formats: MP4, MOV, WebM, MKV
- Application upload limit: 5 GiB per source video
- Multipart part size: 64 MiB
- Up to four parts upload in parallel
- Failed parts are retried automatically
- Incomplete R2 multipart uploads are also automatically aborted by R2 after seven days
- Source objects are deleted from R2 after successful processing and are also cleaned up best-effort when worker processing fails

## Worker dependencies

The runner installs boto3, yt-dlp 2026.6.9, bgutil-ytdlp-pot-provider 1.3.1, faster-whisper 1.2.1, FFmpeg, Node.js 24, and supabase-py 2.31.0.

## Usage

1. Sign in at `/login`.
2. Choose a video file, 3/5/10 clips and 30/45/60 seconds.
3. Upload the video. Multipart data goes directly from the browser to R2.
4. The job queues automatically when the upload completes.
5. Refresh the dashboard after the worker starts. Finished clips and a ZIP appear as download links.

The scheduled worker can take up to roughly five minutes to pick up a newly queued job before processing starts.

## Rights

Use ClipFarm only with videos you own or have permission to edit and republish.
