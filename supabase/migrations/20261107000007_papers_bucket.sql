-- ResearchLens AI — make the papers bucket reproducible.
--
-- The `research-papers` bucket was originally created in the Supabase dashboard (private, PDF only,
-- 50 MB); 20261107000002 only asserted it was private. A fresh project applying migrations would
-- therefore lack the bucket. Create it if missing; never alter an existing bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('research-papers', 'research-papers', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'research-papers' and public) then
    raise exception 'research-papers bucket must be private';
  end if;
end;
$$;
