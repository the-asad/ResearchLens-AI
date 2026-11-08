-- ResearchLens evaluation lab (NOT an application migration).
-- Holds ONLY the public benchmark corpus (arXiv papers) so retrieval experiments use the same
-- PostgreSQL full-text ranking as production. No user data. No privileges for any API role:
-- reachable only through DATABASE_URL (postgres) by the local evaluation scripts.
create schema if not exists eval_lab;
revoke all on schema eval_lab from public, anon, authenticated, service_role;

create table if not exists eval_lab.chunks (
  strategy text not null,
  chunk_key text not null,          -- "<paper>#<index>"
  paper text not null,
  chunk_index integer not null,
  page_start integer not null,
  page_end integer not null,
  section_title text,
  content text not null,
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(section_title, '')), 'A') ||
    setweight(to_tsvector('english', content), 'B')
  ) stored,
  primary key (strategy, chunk_key)
);
create index if not exists eval_lab_chunks_fts on eval_lab.chunks using gin (search_vector);
revoke all on all tables in schema eval_lab from public, anon, authenticated, service_role;

-- Identical query construction and ranking to public.search_document_chunks_lexical.
create or replace function eval_lab.lexical(p_strategy text, query_text text, p_papers text[], match_count integer)
returns table (chunk_key text, rank real)
language sql stable set search_path = '' as $$
  with q as (
    select string_agg('''' || replace(replace(lexeme, '\', ''), '''', '''''') || '''', ' | ')::tsquery as tsq
    from unnest(tsvector_to_array(to_tsvector('english', left(query_text, 1000)))) as lexeme
  )
  select c.chunk_key, ts_rank_cd(c.search_vector, q.tsq, 1) as rank
  from eval_lab.chunks c, q
  where q.tsq is not null and c.strategy = p_strategy
    and (p_papers is null or c.paper = any (p_papers))
    and c.search_vector @@ q.tsq
  order by rank desc, c.chunk_key
  limit match_count;
$$;
revoke execute on function eval_lab.lexical(text, text, text[], integer) from public, anon, authenticated, service_role;
