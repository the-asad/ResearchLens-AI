-- ResearchLens AI — Milestone 2: RAG engine
--
-- * chunk provenance/content-type/embedding-model columns
-- * PostgreSQL full-text search vector + GIN index (lexical retrieval)
-- * dense retrieval rewritten: embedding-model filter, references excluded by default,
--   HNSW iterative scan so owner/project filters cannot starve results
-- * lexical retrieval function (OR-of-lexemes query, ts_rank_cd)
-- * service-role-only ingestion functions: atomic claim + atomic chunk replacement
--
-- Embedding dimensionality stays vector(768): gemini-embedding-2 with
-- output_dimensionality = 768 was verified to return exactly 768 dims (unit-normalised).

-- ---------------------------------------------------------------------------
-- Chunk columns
-- ---------------------------------------------------------------------------

alter table public.document_chunks
  add column content_type text not null default 'text'
    check (content_type in ('text', 'table', 'figure', 'note')),
  add column section_kind text not null default 'body'
    check (section_kind in ('front_matter', 'abstract', 'body', 'references', 'appendix')),
  add column embedding_model text check (char_length(embedding_model) <= 100),
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(section_title, '')), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) stored;

create index document_chunks_search_vector_idx on public.document_chunks using gin (search_vector);

-- Users still have SELECT only; new columns are covered by the existing table grant.

-- ---------------------------------------------------------------------------
-- Dense retrieval (replaces the Milestone 1 signature)
-- ---------------------------------------------------------------------------

drop function if exists public.match_document_chunks(extensions.vector, uuid, uuid[], integer);

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(768),
  p_project_id uuid,
  p_embedding_model text,
  p_document_ids uuid[] default null,
  match_count integer default 20,
  p_include_references boolean default false
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_index integer,
  page_start integer,
  page_end integer,
  section_title text,
  section_kind text,
  content text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
-- pgvector 0.8: keep scanning the HNSW graph until enough rows pass the tenant filters.
set hnsw.iterative_scan = 'strict_order'
set hnsw.ef_search = '100'
as $$
  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.page_start,
    c.page_end,
    c.section_title,
    c.section_kind,
    c.content,
    1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.document_chunks c
  where c.owner_id = (select auth.uid())
    and c.project_id = p_project_id
    and c.embedding is not null
    and c.embedding_model = p_embedding_model
    and (p_document_ids is null or c.document_id = any (p_document_ids))
    and (p_include_references or c.section_kind <> 'references')
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 100);
$$;

revoke execute on function public.match_document_chunks(extensions.vector, uuid, text, uuid[], integer, boolean)
  from public, anon;
grant execute on function public.match_document_chunks(extensions.vector, uuid, text, uuid[], integer, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Lexical retrieval
-- ---------------------------------------------------------------------------
-- websearch/plainto_tsquery AND every term, which fails for natural-language questions.
-- Instead: stem the query with the same 'english' config, OR the lexemes together, and rank
-- with ts_rank_cd (cover density) normalised by document length — chunks matching more and
-- closer terms (e.g. "SQuAD" + "F1") rank higher.

create or replace function public.search_document_chunks_lexical(
  query_text text,
  p_project_id uuid,
  p_document_ids uuid[] default null,
  match_count integer default 20,
  p_include_references boolean default false
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_index integer,
  page_start integer,
  page_end integer,
  section_title text,
  section_kind text,
  content text,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) as tsq
    from unnest(tsvector_to_array(to_tsvector('english', left(query_text, 1000)))) as lexeme
  )
  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.page_start,
    c.page_end,
    c.section_title,
    c.section_kind,
    c.content,
    ts_rank_cd(c.search_vector, q.tsq, 1) as rank
  from public.document_chunks c, q
  where q.tsq is not null
    and c.owner_id = (select auth.uid())
    and c.project_id = p_project_id
    and (p_document_ids is null or c.document_id = any (p_document_ids))
    and (p_include_references or c.section_kind <> 'references')
    and c.search_vector @@ q.tsq
  order by rank desc, c.chunk_index
  limit least(greatest(match_count, 1), 100);
$$;

revoke execute on function public.search_document_chunks_lexical(text, uuid, uuid[], integer, boolean)
  from public, anon;
grant execute on function public.search_document_chunks_lexical(text, uuid, uuid[], integer, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Ingestion (service role only — never executable by anon/authenticated)
-- ---------------------------------------------------------------------------

-- Atomically move a verified document into 'processing'. Returns the row only if this caller
-- won the claim, so concurrent "Process" clicks cannot run two ingestions.
create or replace function public.claim_document_for_processing(
  p_document_id uuid,
  p_owner_id uuid,
  p_stale_after interval default interval '15 minutes'
)
returns setof public.documents
language sql
security invoker
set search_path = ''
as $$
  update public.documents d
  set status = 'processing',
      error_message = null,
      processing_metadata = d.processing_metadata
        || jsonb_build_object('processing_started_at', now(), 'ingestion', 'running')
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.processing_metadata ? 'verified_at'
    and (
      d.status in ('uploaded', 'failed', 'ready')
      or (d.status = 'processing'
          and coalesce((d.processing_metadata ->> 'processing_started_at')::timestamptz, d.updated_at)
              < now() - p_stale_after)
    )
  returning d.*;
$$;

-- Replace all chunks of a document and mark it ready, in ONE transaction. Retrying ingestion
-- therefore never duplicates chunks and never leaves a half-written chunk set visible.
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
    section_kind, content_type, content, token_count, embedding, embedding_model, metadata
  )
  select
    p_document_id,
    p_owner_id,
    v_project_id,
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
    coalesce(c -> 'metadata', '{}'::jsonb)
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

revoke execute on function public.claim_document_for_processing(uuid, uuid, interval) from public, anon, authenticated;
revoke execute on function public.replace_document_chunks(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.claim_document_for_processing(uuid, uuid, interval) to service_role;
grant execute on function public.replace_document_chunks(uuid, uuid, jsonb, jsonb) to service_role;
