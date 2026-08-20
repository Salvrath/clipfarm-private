create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null default 'youtube',
  source_url text,
  source_path text,
  source_name text,
  clip_count int not null check (clip_count in (3, 5, 10)),
  clip_length int not null check (clip_length in (30, 45, 60)),
  status text not null default 'queued',
  error_message text,
  assets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.jobs add column if not exists source_type text not null default 'youtube';
alter table public.jobs add column if not exists source_path text;
alter table public.jobs add column if not exists source_name text;
alter table public.jobs alter column source_url drop not null;

alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check
  check (status in ('uploading', 'queued', 'processing', 'complete', 'failed'));

alter table public.jobs drop constraint if exists jobs_source_type_check;
alter table public.jobs add constraint jobs_source_type_check
  check (source_type in ('youtube', 'upload'));

alter table public.jobs drop constraint if exists jobs_source_fields_check;
alter table public.jobs add constraint jobs_source_fields_check check (
  (source_type = 'youtube' and source_url is not null)
  or
  (source_type = 'upload' and (source_path is not null or status = 'complete'))
);

alter table public.jobs enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.jobs to authenticated;

drop policy if exists "jobs_select_own" on public.jobs;
create policy "jobs_select_own" on public.jobs for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "jobs_insert_own" on public.jobs;
create policy "jobs_insert_own" on public.jobs for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "jobs_update_own" on public.jobs;
create policy "jobs_update_own" on public.jobs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "jobs_delete_own" on public.jobs;
create policy "jobs_delete_own" on public.jobs for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.set_updated_at() returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at before update on public.jobs for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 1073741824, array['video/mp4', 'application/zip'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sources',
  'sources',
  false,
  1073741824,
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "users_read_own_clips" on storage.objects;
create policy "users_read_own_clips"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'clips'
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[1]
      and j.user_id = (select auth.uid())
  )
);

drop policy if exists "users_upload_own_sources" on storage.objects;
create policy "users_upload_own_sources"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'sources'
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[1]
      and j.user_id = (select auth.uid())
      and j.source_type = 'upload'
      and j.status = 'uploading'
  )
);

drop policy if exists "users_read_own_sources" on storage.objects;
create policy "users_read_own_sources"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'sources'
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[1]
      and j.user_id = (select auth.uid())
      and j.source_type = 'upload'
  )
);

drop policy if exists "users_delete_own_sources" on storage.objects;
create policy "users_delete_own_sources"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'sources'
  and exists (
    select 1
    from public.jobs j
    where j.id::text = (storage.foldername(name))[1]
      and j.user_id = (select auth.uid())
      and j.source_type = 'upload'
  )
);
