-- ResearchLens AI — forward fix for lexical retrieval query construction.
--
-- 20261107000003 built the OR-query with to_tsquery('simple', quote_literal(lexeme) ...), which
-- re-parses each already-stemmed lexeme: compound identifiers such as 'bert-larg' or 'resnet-50'
-- were split into phrase queries ('bert-larg' <-> 'bert' <-> 'larg'). This migration casts the
-- lexemes directly to tsquery (no re-parsing) so they stay single lexemes.
-- Same signature, security mode and grants; no data changes.

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
    -- Lexemes are already normalised by the 'english' config; cast them directly to tsquery
    -- (no re-parsing) so compound identifiers such as 'bert-larg' stay single lexemes.
    select string_agg('''' || replace(replace(lexeme, '\', ''), '''', '''''') || '''', ' | ')::tsquery as tsq
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
