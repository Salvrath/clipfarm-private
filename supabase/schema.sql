create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  clip_count int not null check (clip_count in (3, 5, 10)),
  clip_length int not null check (clip_length in (30, 45, 60)),
  status text not null default 'queued' check (status in ('queued', 'processing', 'complete', 'failed')),
  error_message text,
  assets jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.jobs enable row level security;

drop policy if exists "jobs are private" on public.jobs;
create policy "jobs are private" on public.jobs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at before update on public.jobs for each row execute procedure public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 1073741824, array['video/mp4', 'application/zip'])
on conflict (id) do nothing;
