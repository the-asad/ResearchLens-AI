-- ResearchLens AI — core schema (Milestone 1)
--
-- Tables: profiles, projects, documents, document_chunks
-- Every user-owned row carries owner_id and is protected by RLS scoped to auth.uid().
-- Conversations / messages / claims / claim_evidence are deliberately deferred to the
-- milestones that implement them (see docs/ARCHITECTURE.md → "Schema decisions").

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile automatically when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 120)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for composite FKs so children can only reference a project of the same owner.
  unique (id, owner_id)
);

create index projects_owner_created_idx on public.projects (owner_id, created_at desc);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create type public.document_status as enum (
  'pending_upload', -- row created, signed upload URL issued, object not yet verified
  'uploaded',       -- object verified (size, MIME, %PDF- signature); awaiting ingestion
  'processing',     -- ingestion pipeline running (future milestone)
  'ready',          -- chunks + embeddings available (future milestone)
  'failed'          -- verification or ingestion failed; see error_message
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  -- Storage path is derived, never user-supplied: {owner}/{project}/{document}/original.pdf
  storage_path text generated always as (
    owner_id::text || '/' || project_id::text || '/' || id::text || '/original.pdf'
  ) stored,
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 52428800),
  status public.document_status not null default 'pending_upload',
  title text check (char_length(title) <= 500),
  page_count integer check (page_count is null or page_count >= 0),
  error_message text check (char_length(error_message) <= 1000),
  processing_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (storage_path),
  -- Same-owner project; NO ACTION (not cascade) so a project cannot be deleted while it
  -- still has documents whose storage objects would be orphaned. Account deletion still
  -- works because both rows cascade from auth.users within the same statement.
  foreign key (project_id, owner_id) references public.projects (id, owner_id)
);

create index documents_owner_created_idx on public.documents (owner_id, created_at desc);
create index documents_project_idx on public.documents (project_id, created_at desc);
create index documents_owner_status_idx on public.documents (owner_id, status);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- document_chunks (written only by the server-side ingestion pipeline)
-- ---------------------------------------------------------------------------

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  page_start integer check (page_start is null or page_start >= 1),
  page_end integer check (page_end is null or page_end >= page_start),
  section_title text check (char_length(section_title) <= 500),
  content text not null check (char_length(content) between 1 and 20000),
  token_count integer check (token_count is null or token_count >= 0),
  -- 768-dim embeddings (e.g. Gemini embedding with output_dimensionality = 768).
  embedding extensions.vector(768),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  -- Chunk ownership must match its document; deleting a document removes its chunks.
  foreign key (document_id, owner_id) references public.documents (id, owner_id) on delete cascade,
  foreign key (project_id, owner_id) references public.projects (id, owner_id)
);

create index document_chunks_owner_project_idx on public.document_chunks (owner_id, project_id);
create index document_chunks_document_idx on public.document_chunks (document_id, chunk_index);
create index document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;

-- Least privilege: start from nothing, then grant only what the app needs.
revoke all on public.profiles, public.projects, public.documents, public.document_chunks
  from anon, authenticated;

-- profiles: read/update own row only (insert happens via trigger).
grant select, update (display_name) on public.profiles to authenticated;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- projects: full CRUD on own rows.
grant select, insert (name, description), update (name, description), delete
  on public.projects to authenticated;

create policy "projects_select_own" on public.projects
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "projects_insert_own" on public.projects
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "projects_update_own" on public.projects
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "projects_delete_own" on public.projects
  for delete to authenticated using (owner_id = (select auth.uid()));

-- documents: users may create a pending row, read, rename (title) and delete their own.
-- Status / verification / processing fields are only writable by the server (service role)
-- so a client cannot mark a document "ready" or forge processing results.
grant select, insert (project_id, original_filename, file_size_bytes, mime_type),
  update (title), delete
  on public.documents to authenticated;

create policy "documents_select_own" on public.documents
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "documents_insert_own_pending" on public.documents
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'pending_upload');
create policy "documents_update_own" on public.documents
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "documents_delete_own" on public.documents
  for delete to authenticated using (owner_id = (select auth.uid()));

-- document_chunks: read-only for owners; deletion happens by cascade from documents.
grant select on public.document_chunks to authenticated;

create policy "document_chunks_select_own" on public.document_chunks
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Tenant-isolated vector retrieval
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: runs with the caller's privileges, so RLS applies. The explicit
-- owner_id = auth.uid() filter is defence in depth, and project scope is mandatory.

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(768),
  p_project_id uuid,
  p_document_ids uuid[] default null,
  match_count integer default 8
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_index integer,
  page_start integer,
  page_end integer,
  section_title text,
  content text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.page_start,
    c.page_end,
    c.section_title,
    c.content,
    1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.document_chunks c
  where c.owner_id = (select auth.uid())
    and c.project_id = p_project_id
    and c.embedding is not null
    and (p_document_ids is null or c.document_id = any (p_document_ids))
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

revoke execute on function public.match_document_chunks(extensions.vector, uuid, uuid[], integer)
  from public, anon;
grant execute on function public.match_document_chunks(extensions.vector, uuid, uuid[], integer)
  to authenticated;
