-- ResearchLens AI — Milestone 3: multimodal evidence model, research notes, background jobs.
--
-- * document_chunks: richer content types + provenance (bbox, structured payload, derivation,
--   source asset, confidence, embedding modality, parent/child link)
-- * documents.kind ('paper' | 'note') with image MIME types for notes and a derived storage path
-- * private buckets: research-notes (user uploads, owner-scoped policies) and research-derived
--   (server-written artifacts: Docling JSON, figure crops — NO user policies at all)
-- * ingestion_jobs queue (owner-readable; written/claimed by the service role only)

-- ---------------------------------------------------------------------------
-- Evidence model
-- ---------------------------------------------------------------------------
alter table public.document_chunks drop constraint document_chunks_content_type_check;
alter table public.document_chunks
  add constraint document_chunks_content_type_check check (content_type in
    ('text', 'table', 'figure', 'graph', 'equation', 'handwritten_note', 'image_note', 'ocr_text')),
  add column bbox jsonb,                       -- [x0, y0, x1, y1] PDF points, top-left origin
  add column structured jsonb,                 -- table cells / figure description / note structure
  add column derivation text not null default 'pdf_text'
    check (derivation in ('pdf_text', 'layout_model', 'ocr', 'vision', 'table_model')),
  add column source_asset_path text check (char_length(source_asset_path) <= 500),
  add column confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  add column embedding_modality text not null default 'text' check (embedding_modality in ('text', 'image', 'multimodal')),
  add column parent_chunk_index integer check (parent_chunk_index is null or parent_chunk_index >= 0);

-- ---------------------------------------------------------------------------
-- Notes as a document kind
-- ---------------------------------------------------------------------------
alter table public.documents
  add column kind text not null default 'paper' check (kind in ('paper', 'note'));

alter table public.documents drop constraint documents_mime_type_check;
alter table public.documents add constraint documents_mime_type_check check (
  (kind = 'paper' and mime_type = 'application/pdf')
  or (kind = 'note' and mime_type in ('image/png', 'image/jpeg', 'image/webp'))
);
alter table public.documents add constraint documents_note_size_check
  check (kind = 'paper' or file_size_bytes <= 15728640);

-- Paper paths are unchanged (…/original.pdf); notes get …/note.<ext>. PG 17 SET EXPRESSION.
alter table public.documents alter column storage_path set expression as (
  owner_id::text || '/' || project_id::text || '/' || id::text || '/' ||
  case
    when kind = 'note' then 'note.' || case mime_type when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end
    else 'original.pdf'
  end
);

-- Users may now also choose the kind when creating their own pending row.
revoke insert on public.documents from authenticated;
grant insert (project_id, original_filename, file_size_bytes, mime_type, kind) on public.documents to authenticated;

-- ---------------------------------------------------------------------------
-- Private buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('research-notes', 'research-notes', false, 15728640, array['image/png', 'image/jpeg', 'image/webp']),
  ('research-derived', 'research-derived', false, 20971520, array['application/json', 'image/png'])
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from storage.buckets where id in ('research-papers', 'research-notes', 'research-derived') and public) then
    raise exception 'ResearchLens buckets must be private';
  end if;
end;
$$;

create policy "research_notes_insert_own_pending"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'research-notes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name and d.owner_id = (select auth.uid())
        and d.kind = 'note' and d.status = 'pending_upload'
    )
  );
create policy "research_notes_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'research-notes'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.documents d where d.storage_path = storage.objects.name and d.owner_id = (select auth.uid()))
  );
create policy "research_notes_delete_own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'research-notes' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- research-derived: intentionally NO policies → no direct user access. The server serves
-- derived assets only after an ownership check, via short-lived signed URLs.

-- ---------------------------------------------------------------------------
-- Background jobs (document intelligence worker → indexer)
-- ---------------------------------------------------------------------------
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null,
  kind text not null check (kind in ('docintel', 'index')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_by text check (char_length(locked_by) <= 100),
  locked_at timestamptz,
  error text check (char_length(error) <= 1000),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (document_id, owner_id) references public.documents (id, owner_id) on delete cascade
);
create index ingestion_jobs_queue_idx on public.ingestion_jobs (kind, status, created_at);
create index ingestion_jobs_document_idx on public.ingestion_jobs (document_id, created_at desc);
create trigger ingestion_jobs_set_updated_at before update on public.ingestion_jobs
  for each row execute function public.set_updated_at();

alter table public.ingestion_jobs enable row level security;
revoke all on public.ingestion_jobs from anon, authenticated;
grant select on public.ingestion_jobs to authenticated;
create policy "ingestion_jobs_select_own" on public.ingestion_jobs
  for select to authenticated using (owner_id = (select auth.uid()));
grant select, insert, update on public.ingestion_jobs to service_role;

-- Claim the oldest queued job of the given kinds (or a stale running one). SKIP LOCKED lets
-- several workers run safely; attempts are capped so a poison job cannot loop forever.
create or replace function public.claim_ingestion_job(p_worker text, p_kinds text[], p_stale_after interval default interval '20 minutes')
returns setof public.ingestion_jobs
language sql
security invoker
set search_path = ''
as $$
  update public.ingestion_jobs j
  set status = 'running', locked_by = left(p_worker, 100), locked_at = now(), attempts = j.attempts + 1
  where j.id = (
    select id from public.ingestion_jobs
    where kind = any (p_kinds)
      and attempts < 3
      and (status = 'queued' or (status = 'running' and locked_at < now() - p_stale_after))
    order by created_at
    for update skip locked
    limit 1
  )
  returning j.*;
$$;
revoke execute on function public.claim_ingestion_job(text, text[], interval) from public, anon, authenticated;
grant execute on function public.claim_ingestion_job(text, text[], interval) to service_role;

-- ---------------------------------------------------------------------------
-- Chunk writer: carry the new provenance columns
-- ---------------------------------------------------------------------------
create or replace function public.replace_document_chunks(
  p_document_id uuid,
  p_owner_id uuid,
  p_chunks jsonb,
  p_document_patch jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_count integer;
begin
  select project_id into v_project_id
  from public.documents
  where id = p_document_id and owner_id = p_owner_id and status = 'processing'
  for update;
  if v_project_id is null then
    raise exception 'document % is not in processing state for this owner', p_document_id;
  end if;

  delete from public.document_chunks where document_id = p_document_id;

  insert into public.document_chunks (
    document_id, owner_id, project_id, chunk_index, page_start, page_end, section_title,
    section_kind, content_type, content, token_count, embedding, embedding_model, metadata,
    bbox, structured, derivation, source_asset_path, confidence, embedding_modality, parent_chunk_index
  )
  select
    p_document_id, p_owner_id, v_project_id,
    (c ->> 'chunk_index')::integer,
    (c ->> 'page_start')::integer,
    (c ->> 'page_end')::integer,
    nullif(c ->> 'section_title', ''),
    coalesce(c ->> 'section_kind', 'body'),
    coalesce(c ->> 'content_type', 'text'),
    c ->> 'content',
    (c ->> 'token_count')::integer,
    (c ->> 'embedding')::extensions.vector(768),
    c ->> 'embedding_model',
    coalesce(c -> 'metadata', '{}'::jsonb),
    c -> 'bbox',
    c -> 'structured',
    coalesce(c ->> 'derivation', 'pdf_text'),
    c ->> 'source_asset_path',
    (c ->> 'confidence')::real,
    coalesce(c ->> 'embedding_modality', 'text'),
    (c ->> 'parent_chunk_index')::integer
  from jsonb_array_elements(p_chunks) as c;
  get diagnostics v_count = row_count;

  update public.documents
  set status = 'ready',
      error_message = null,
      title = coalesce(nullif(p_document_patch ->> 'title', ''), title),
      page_count = (p_document_patch ->> 'page_count')::integer,
      processing_metadata = processing_metadata || coalesce(p_document_patch -> 'processing_metadata', '{}'::jsonb)
  where id = p_document_id and owner_id = p_owner_id;

  return v_count;
end;
$$;
revoke execute on function public.replace_document_chunks(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_document_chunks(uuid, uuid, jsonb, jsonb) to service_role;
