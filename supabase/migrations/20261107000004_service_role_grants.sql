-- ResearchLens AI — explicit, least-privilege grants for the service role.
--
-- Root cause of the first real upload failure: in this project, tables created by `postgres`
-- receive default privileges that give `service_role` only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN
-- (no SELECT/INSERT/UPDATE/DELETE). Earlier migrations assumed the older Supabase behaviour of
-- granting the API roles full table access, so the server-owned status transition
-- (pending_upload → uploaded) and chunk writes failed with "permission denied".
--
-- Grant ONLY what server code performs with the secret key (always after verifying ownership
-- with the user's RLS-scoped client, and always filtered by owner_id):
--   documents       : status transitions (finalize, claim, mark failed) → SELECT, UPDATE
--   document_chunks : atomic chunk replacement                          → SELECT, INSERT, DELETE
-- No grants on profiles or projects: the service role never touches them.
-- No change to RLS policies, user grants, storage policies or the bucket.

grant select, update on public.documents to service_role;
grant select, insert, delete on public.document_chunks to service_role;
