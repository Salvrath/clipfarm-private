# ClipFarm

ClipFarm is a private MVP for turning one YouTube or Twitch VOD URL into short-form vertical clips with burned-in captions. It is intentionally built for one user, not as a SaaS product.

## What it does

- Private Supabase email/password login.
- Dashboard with a single YouTube/Twitch VOD URL input.
- Clip count choices: 3, 5, or 10.
- Clip length choices: 30s, 45s, or 60s.
- Job statuses: `queued`, `processing`, `complete`, and `failed`.
- Python worker downloads with `yt-dlp`, transcribes with `faster-whisper`, picks transcript-based highlights, renders 9:16 MP4 clips with captions via `ffmpeg`, uploads clips plus a ZIP to Supabase Storage, then deletes the original long video from worker disk.
- Generated clips and ZIP are marked to expire after 24 hours. Run the cleanup endpoint/task in the worker to remove expired storage objects.

## Repository layout

- `app/` - Next.js App Router frontend and route handlers for Vercel.
- `lib/` - Supabase server helpers and shared types.
- `supabase/schema.sql` - Jobs table, row-level security, and private storage bucket setup.
- `worker/` - FastAPI worker deployable to Hugging Face Spaces or any Python container host.

## Supabase setup

1. Create a Supabase project.
2. In **Authentication > Users**, create your private user with an email and password. Keep email/password auth enabled and disable public signups for the private MVP.
3. Run `supabase/schema.sql` in the Supabase SQL editor.
4. Copy these values for deployment:
   - Project URL: `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL`
   - anon key: `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - service role key: `SUPABASE_SERVICE_ROLE_KEY`
5. Keep the `clips` storage bucket private.

## Vercel setup

1. Import this repo into Vercel.
2. Set environment variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=clips
WORKER_URL=https://your-space-name.hf.space
WORKER_SHARED_SECRET=change-me
```

3. Deploy. Open `/login`, sign in with your private email and password, then use `/dashboard`.

## Hugging Face Spaces worker setup

1. Create a new Space using the Docker SDK.
2. Point the Space at the `worker/` directory, or copy `worker/Dockerfile`, `worker/requirements.txt`, and `worker/main.py` into the Space repo root.
3. Add Space secrets:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=clips
WORKER_SHARED_SECRET=the-same-value-used-in-vercel
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
```

4. The worker exposes:
   - `GET /` for health checks.
   - `POST /jobs` to start a background processing task. Vercel calls this after creating a job.

## Local development

```bash
npm install
npm run dev
```

Run the worker locally in a second terminal:

```bash
cd worker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 7860
```

Use `WORKER_URL=http://localhost:7860` for local frontend-to-worker requests.

## Cleanup

Completed jobs store an `expires_at` value 24 hours after processing. The worker includes `cleanup_expired()` for scheduled cleanup. For a simple MVP, run it from a Hugging Face scheduled restart script, a small cron container, or a temporary Python shell:

```bash
python -c "from main import cleanup_expired; print(cleanup_expired())"
```

This removes expired MP4/ZIP objects from Supabase Storage and clears job asset references.

## Notes and limits

- The worker processes in the background of the API process; keep one job at a time for the private MVP.
- Large VODs can exceed free-tier CPU, memory, or timeout limits. Start with shorter videos while testing.
- No payments, teams, or social auto-upload features are included.
