# Security model

Research papers may be confidential or unpublished. Controls are layered so no single bug exposes
another user's data.

## Authentication
- Supabase Auth (email + password) via `@supabase/ssr` cookie sessions; separate browser
  (`src/lib/supabase/client.ts`) and per-request server (`src/lib/supabase/server.ts`) clients.
- Server identity always comes from `auth.getClaims()` (JWT signature + expiry verified).
  `getSession()` is never used on the server (enforced by `tests/security-static.test.ts`).
- `src/proxy.ts` refreshes sessions and redirects unauthenticated users away from
  `/dashboard`, `/projects`, `/documents`, `/settings`. It is an optimistic check only; every page
  and action re-verifies with `requireUser()`.
- Post-login redirects go through `safeNextPath` (relative paths only — no open redirects).
- Login errors are generic (no account enumeration).

## Authorization (database layer)
- RLS enabled on `profiles`, `projects`, `documents`, `document_chunks`; every policy is
  `owner_id = (select auth.uid())` (profiles: `id = auth.uid()`). No `using (true)` policies.
- Table privileges are revoked from `anon`/`authenticated` and re-granted per column:
  - users cannot set `owner_id`, `status`, `storage_path`, `error_message`, `processing_metadata`;
  - users cannot insert/update `document_chunks` (only the server pipeline writes evidence).
- Composite FKs prevent cross-owner parent references.
- Verified by `supabase/tests/rls_isolation.sql` (two synthetic users, rolled back).

## Tenant-isolated retrieval (RAG)
- Dense **and** lexical search functions are `SECURITY INVOKER` with explicit `owner_id = auth.uid()`
  and a mandatory project; the app also validates the project and every selected document id
  against the caller's RLS view **before** any retrieval, and discards any row outside that scope.
- Dense search filters on `embedding_model`, so vectors from different models never mix.
- Chunks are written only by `replace_document_chunks` (service role), after ownership is checked
  with the user's client; the PDF is downloaded with the user's client (storage RLS).
- Citations are validated server-side: only ids of passages actually supplied, from authorised
  documents, with page metadata, survive.
- Live test: `supabase/tests/rls_isolation.sql` (cross-tenant dense + lexical, model isolation,
  service-role-only functions, service-role grants). The evaluation harness re-probes cross-user
  retrieval against the real indexed paper.

### Original retrieval note
`match_document_chunks` is `SECURITY INVOKER` (RLS applies), filters `owner_id = auth.uid()`
explicitly, requires a `project_id`, optionally narrows to document ids, and caps results at 50.
There is no global similarity search function.

## Storage
- Bucket `research-papers` is private (50 MB, `application/pdf`). Migrations assert it is private
  and never modify it.
- Paths are generated in Postgres: `{owner_id}/{project_id}/{document_id}/original.pdf`. Filenames
  are display metadata only.
- Storage RLS: insert only to the exact path of your own `pending_upload` document; select only
  your own documents' objects; delete only within your folder; no update (originals immutable).
- Viewing uses a 60-second signed URL issued after an ownership check.

## Upload validation
Authenticated user → Zod (UUID, size ≤ 50 MB, MIME `application/pdf`, `.pdf` extension) →
bucket MIME/size limits → post-upload verification of stored size and `%PDF-` magic bytes.
Failures delete the object and mark the document `failed`.

## Secrets
- Server-only: `SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `DATABASE_URL`.
  Read only in `src/lib/env.server.ts` (`import "server-only"`). Never `NEXT_PUBLIC_*`.
- The service-role client (`src/lib/supabase/admin.ts`) is used only in `src/lib/documents.ts`
  (upload status transitions) and `src/lib/rag/server.ts` (ingestion claim / chunk replacement /
  failure status), always after ownership is verified with the user client and with an explicit
  `owner_id` filter (enforced by `tests/security-static.test.ts`). Its table privileges are granted
  explicitly and minimally: `documents` SELECT/UPDATE, `document_chunks` SELECT/INSERT/DELETE, nothing
  on `projects`/`profiles`.
- `.env*` is git-ignored (`.env.example` excepted). Static tests scan for hard-coded keys and for
  secret names in client components; the built client bundle was scanned for secret values.

## Prompt-injection boundary
`src/lib/ai/prompts.ts` defines one system policy for every call:
SYSTEM POLICY (trusted) › USER QUERY › RETRIEVED EVIDENCE (untrusted data). Evidence is wrapped in
`<evidence><passage id=…>` blocks; tag-like text that could close or spoof these delimiters is
escaped. The model is told never to follow instructions inside evidence. This is secondary:
authorization and tenant-scoped retrieval decide what evidence can reach the model at all.

## Logging
Structured operational events only (ids, byte counts, chunk counts, provider/model, latency, error
kinds and Postgres error codes). No PDF contents, passages, questions, prompts, outputs, tokens or
keys. The chat debug trace returns only the caller's own RLS-scoped chunk ids, ranks and scores.

## Data lifecycle
- Delete document: storage object removed first, then the row; chunks cascade.
- Delete project: all its objects and documents are removed first; the FK (`NO ACTION`) blocks
  deleting a project that still has documents, preventing orphaned files.
- Account deletion cascades all rows from `auth.users`. **Gap:** storage objects are not yet
  removed on account deletion — needs an account-deletion flow that purges the user's folder.

## Milestone 3 additions (multimodal, notes, workers)
- **Buckets (all private):** `research-papers` (PDF), `research-notes` (PNG/JPEG/WebP ≤ 15 MB, same
  owner-scoped insert/select/delete policies as papers), `research-derived` (Docling JSON, figure
  crops) with **no user policies at all** — users reach derived assets only through
  `/documents/[id]/asset?chunk=…`, which loads the chunk with the user's RLS client, checks the
  asset path sits under `{owner}/{project}/{document}/derived/`, and redirects to a 60 s signed URL.
- **Uploads:** notes are validated by Zod (type, size), bucket MIME/size limits and image magic
  bytes (PNG/JPEG/WebP must match the declared type); SVG and PDFs-as-notes are rejected.
- **Jobs:** `ingestion_jobs` is owner-readable only; jobs are inserted and claimed by the service
  role (`claim_ingestion_job`, SKIP LOCKED). Workers are pull-only (no inbound endpoint), re-read
  each document by id **and** owner, and refuse paths outside the owner prefix.
- **Indexer:** every service-role read/update in `src/lib/rag/indexer.ts` is owner-filtered
  (static test); chunks are still written only via `replace_document_chunks`.
- **Deletion:** removing a document or project now also removes its note image and every derived
  asset (`removeDerivedAssets`), so no figure crops or Docling JSON are orphaned.
- **Answers:** besides citation validation, every number stated in an answer sentence must appear
  in a passage that sentence cites; otherwise the sentence is dropped (numeric fidelity).
- **Caches:** query-embedding and rerank caches are per server instance and keyed by a hash that
  includes the user id, project and model/version — never shared across tenants.
- **Prompt injection in notes/OCR:** OCR and note text enter the same delimited untrusted-evidence
  channel as PDF text.

## HTTP hardening
`X-Frame-Options: DENY`, `nosniff`, HSTS, strict referrer policy, restricted permissions policy,
`X-Powered-By` disabled. Server actions get Next.js same-origin checks.

## Known gaps / next steps
- No rate limiting on uploads/auth beyond Supabase defaults.
- No CSP yet (add once third-party scripts are settled).
- No malware scanning of PDFs; PDFs are never rendered server-side yet.
- Stale `pending_upload` rows are not auto-expired (user can delete them).
