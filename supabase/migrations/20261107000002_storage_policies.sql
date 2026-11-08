-- ResearchLens AI — private storage policies for the `research-papers` bucket.
--
-- The bucket itself is created in the dashboard as PRIVATE. This migration never changes
-- that; it only asserts it and adds owner-scoped RLS policies on storage.objects.
-- Object paths are {owner_id}/{project_id}/{document_id}/original.pdf and must match an
-- existing documents.storage_path owned by the caller.

do $$
begin
  if exists (select 1 from storage.buckets where id = 'research-papers' and public) then
    raise exception 'research-papers bucket must be private';
  end if;
end;
$$;

-- Upload: only into the exact path of one of your own documents that is awaiting upload.
create policy "research_papers_insert_own_pending"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'research-papers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name
        and d.owner_id = (select auth.uid())
        and d.status = 'pending_upload'
    )
  );

-- Read (signed URLs / download): only objects inside your own folder that belong to one
-- of your documents.
create policy "research_papers_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'research-papers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name
        and d.owner_id = (select auth.uid())
    )
  );

-- Delete: only objects inside your own folder.
create policy "research_papers_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'research-papers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- No UPDATE policy: uploaded originals are immutable (no overwrite / upsert).
