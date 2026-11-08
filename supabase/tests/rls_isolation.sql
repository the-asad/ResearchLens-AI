-- RLS / tenant-isolation test. Runs entirely inside a transaction that is ROLLED BACK,
-- so it leaves no data behind. Any failed assertion raises and aborts the run.
begin;

-- Two synthetic users (rolled back at the end).
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@test.invalid', '{"display_name":"A"}', now(), now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@test.invalid', '{}', now(), now());

create temp table _ids (k text primary key, v uuid) on commit drop;
grant all on _ids to authenticated, service_role;

-- Act as user A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare p uuid; d uuid; n int; path text;
begin
  -- profile was created by trigger and is visible
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'A should see exactly own profile, saw %', n; end if;

  insert into public.projects (name) values ('A project') returning id into p;
  insert into _ids values ('pa', p);
  insert into public.documents (project_id, original_filename, file_size_bytes)
    values (p, 'a.pdf', 100) returning id, storage_path into d, path;
  insert into _ids values ('da', d);
  if path <> 'aaaaaaaa-0000-4000-8000-000000000001/' || p || '/' || d || '/original.pdf' then
    raise exception 'storage_path not derived correctly: %', path;
  end if;

  -- cannot forge status on insert
  begin
    insert into public.documents (project_id, original_filename, file_size_bytes, status) values (p, 'x.pdf', 1, 'ready');
    raise exception 'FAIL: inserted with forged status';
  exception when insufficient_privilege then null;
  end;

  -- cannot update status
  begin
    update public.documents set status = 'ready' where id = d;
    raise exception 'FAIL: updated status as user';
  exception when insufficient_privilege then null;
  end;

  -- cannot insert chunks directly
  begin
    insert into public.document_chunks (document_id, owner_id, project_id, chunk_index, content)
      values (d, 'aaaaaaaa-0000-4000-8000-000000000001', p, 0, 'fake evidence');
    raise exception 'FAIL: user inserted chunk';
  exception when insufficient_privilege then null;
  end;

  -- cannot create rows owned by someone else
  begin
    insert into public.projects (name, owner_id) values ('spoof', 'bbbbbbbb-0000-4000-8000-000000000002');
    raise exception 'FAIL: inserted project for another owner';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Seed chunks as the server (service role bypasses RLS), for A and later B.
reset role;
insert into public.document_chunks (document_id, owner_id, project_id, chunk_index, content, embedding, embedding_model)
select (select v from _ids where k = 'da'), 'aaaaaaaa-0000-4000-8000-000000000001', (select v from _ids where k = 'pa'),
       0, 'A secret finding about attention heads', array_fill(0.1::real, array[768])::extensions.vector, 'test-model';

-- Act as user B.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);

do $$
declare pb uuid; n int; pa uuid := (select v from _ids where k = 'pa'); da uuid := (select v from _ids where k = 'da');
begin
  select count(*) into n from public.projects;           if n <> 0 then raise exception 'FAIL: B sees % projects', n; end if;
  select count(*) into n from public.documents;          if n <> 0 then raise exception 'FAIL: B sees % documents', n; end if;
  select count(*) into n from public.document_chunks;    if n <> 0 then raise exception 'FAIL: B sees % chunks', n; end if;
  select count(*) into n from public.profiles;           if n <> 1 then raise exception 'FAIL: B sees % profiles', n; end if;

  -- B cannot modify or delete A's rows (RLS makes them invisible: 0 rows affected)
  update public.projects set name = 'pwned' where id = pa;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B updated A project'; end if;
  delete from public.documents where id = da;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: B deleted A document'; end if;

  -- B cannot attach a document to A's project (composite FK + RLS)
  begin
    insert into public.documents (project_id, original_filename, file_size_bytes) values (pa, 'b.pdf', 1);
    raise exception 'FAIL: B attached a document to A project';
  exception when foreign_key_violation or insufficient_privilege then null;
  end;

  -- Vector + lexical search: B asking for A's project returns nothing
  select count(*) into n from public.match_document_chunks(array_fill(0.1::real, array[768])::extensions.vector, pa, 'test-model', null, 10);
  if n <> 0 then raise exception 'FAIL: cross-tenant vector retrieval returned % rows', n; end if;
  select count(*) into n from public.search_document_chunks_lexical('secret attention heads', pa, null, 10);
  if n <> 0 then raise exception 'FAIL: cross-tenant lexical retrieval returned % rows', n; end if;

  -- B cannot call the service-role-only ingestion functions
  begin
    perform public.replace_document_chunks(da, 'bbbbbbbb-0000-4000-8000-000000000002', '[]'::jsonb, '{}'::jsonb);
    raise exception 'FAIL: authenticated user executed replace_document_chunks';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_document_for_processing(da, 'aaaaaaaa-0000-4000-8000-000000000001');
    raise exception 'FAIL: authenticated user executed claim_document_for_processing';
  exception when insufficient_privilege then null;
  end;

  insert into public.projects (name) values ('B project') returning id into pb;
end $$;

-- Back to A: retrieval works for the owner, and deletion cascades to chunks.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare n int; pa uuid := (select v from _ids where k = 'pa'); da uuid := (select v from _ids where k = 'da');
begin
  select count(*) into n from public.projects; if n <> 1 then raise exception 'FAIL: A sees % projects (expected own only)', n; end if;
  select count(*) into n from public.match_document_chunks(array_fill(0.1::real, array[768])::extensions.vector, pa, 'test-model', null, 10);
  if n <> 1 then raise exception 'FAIL: owner retrieval returned % rows', n; end if;
  -- vectors from a different embedding model are never mixed into results
  select count(*) into n from public.match_document_chunks(array_fill(0.1::real, array[768])::extensions.vector, pa, 'other-model', null, 10);
  if n <> 0 then raise exception 'FAIL: retrieval mixed embedding models'; end if;
  select count(*) into n from public.search_document_chunks_lexical('secret attention heads', pa, null, 10);
  if n <> 1 then raise exception 'FAIL: owner lexical retrieval returned % rows', n; end if;

  -- project with documents cannot be deleted (prevents orphaned storage objects)
  begin
    delete from public.projects where id = pa;
    raise exception 'FAIL: deleted project that still has documents';
  exception when foreign_key_violation then null;
  end;

  delete from public.documents where id = da;
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL: owner could not delete document'; end if;
  reset role;
  select count(*) into n from public.document_chunks where document_id = da;
  if n <> 0 then raise exception 'FAIL: chunks not cascaded'; end if;
end $$;

-- service_role (the secret-key server path) can perform exactly the server-owned operations:
-- finalize (pending_upload → uploaded), claim, atomic chunk replacement — and nothing on projects.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
with x as (
  insert into public.documents (project_id, original_filename, file_size_bytes)
  values ((select v from _ids where k = 'pa'), 'svc.pdf', 100) returning id)
insert into _ids select 'ds', id from x;
reset role;
set local role service_role;
do $$
declare n int; d uuid := (select v from _ids where k = 'ds');
begin
  update public.documents set status = 'uploaded', processing_metadata = '{"verified_at":"now"}'
    where id = d and owner_id = 'aaaaaaaa-0000-4000-8000-000000000001' and status = 'pending_upload';
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL: service_role could not finalize upload'; end if;

  select count(*) into n from public.claim_document_for_processing(d, 'aaaaaaaa-0000-4000-8000-000000000001');
  if n <> 1 then raise exception 'FAIL: service_role could not claim document'; end if;

  select public.replace_document_chunks(d, 'aaaaaaaa-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('chunk_index', 0, 'page_start', 1, 'page_end', 1, 'content', 'svc chunk',
      'token_count', 3, 'embedding', array_fill(0.1::real, array[768])::extensions.vector::text, 'embedding_model', 'test-model')),
    '{"page_count": 1}'::jsonb) into n;
  if n <> 1 then raise exception 'FAIL: service_role could not write chunks'; end if;
  -- retry is idempotent: same chunk set replaces, never duplicates
  update public.documents set status = 'processing' where id = d;
  select public.replace_document_chunks(d, 'aaaaaaaa-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object('chunk_index', 0, 'page_start', 1, 'page_end', 1, 'content', 'svc chunk',
      'token_count', 3, 'embedding', array_fill(0.1::real, array[768])::extensions.vector::text, 'embedding_model', 'test-model')),
    '{"page_count": 1}'::jsonb) into n;
  select count(*) into n from public.document_chunks where document_id = d;
  if n <> 1 then raise exception 'FAIL: chunk replacement duplicated rows (%)', n; end if;

  begin
    perform 1 from public.projects limit 1;
    raise exception 'FAIL: service_role has unnecessary access to projects';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ingestion_jobs: owner-readable only; users cannot create or claim jobs
reset role;
insert into public.ingestion_jobs (owner_id, document_id, kind) values ('aaaaaaaa-0000-4000-8000-000000000001', (select v from _ids where k = 'ds'), 'docintel');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.ingestion_jobs; if n <> 0 then raise exception 'FAIL: B sees A jobs'; end if;
  begin
    insert into public.ingestion_jobs (owner_id, document_id, kind) values ('bbbbbbbb-0000-4000-8000-000000000002', gen_random_uuid(), 'docintel');
    raise exception 'FAIL: user inserted a job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_ingestion_job('x', array['docintel']);
    raise exception 'FAIL: user claimed a job';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare n int;
begin
  select count(*) into n from public.ingestion_jobs; if n <> 1 then raise exception 'FAIL: A cannot see own job (%)', n; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from storage.buckets where id in ('research-papers','research-notes','research-derived') and public) then
    raise exception 'FAIL: a ResearchLens bucket is public';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and (qual ilike '%research-derived%' or with_check ilike '%research-derived%')) then
    raise exception 'FAIL: research-derived has user policies';
  end if;
end $$;

-- anon has no access at all
reset role;
set local role anon;
do $$
begin
  perform 1 from public.documents limit 1;
  raise exception 'FAIL: anon can read documents';
exception when insufficient_privilege then null;
end $$;

reset role;
do $$ begin
  if exists (select 1 from storage.buckets where id = 'research-papers' and public) then
    raise exception 'FAIL: bucket is public';
  end if;
end $$;

select 'RLS isolation tests passed' as result;
rollback;
