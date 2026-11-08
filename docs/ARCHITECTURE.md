# Architecture

ResearchLens AI is a single Next.js 16 (App Router) application backed by Supabase. No separate
services yet — the ingestion worker is the first candidate to split out if PDF parsing exceeds
serverless limits.

```
Browser ──► Next.js proxy (src/proxy.ts)        refresh session cookie, optimistic redirect
              │
              ▼
           Server Components / Server Actions    requireUser() → getClaims() (verified JWT)
              │            │
              │            └──► AI provider layer (src/lib/ai)  Gemini Interactions → Gemini fallback → Groq
              ▼
           Supabase (user-scoped client, publishable key + session)
              ├── Postgres + RLS     profiles, projects, documents, document_chunks (pgvector)
              └── Storage (private)  research-papers/{user}/{project}/{document}/original.pdf

           Supabase service role (src/lib/supabase/admin.ts)  only for server-owned status transitions
```

## Request paths

| Concern | Where |
|---|---|
| Session refresh + route gating | `src/proxy.ts`, `src/lib/supabase/proxy.ts` |
| Verified identity (DAL) | `src/lib/auth.ts` (`getCurrentUser`, `requireUser`) |
| Mutations | `src/app/(app)/actions.ts`, `src/app/(auth)/actions.ts` (Zod-validated server actions) |
| Upload verification | `src/lib/documents.ts` |
| Authorised file viewing | `src/app/(app)/documents/[id]/file/route.ts` (60 s signed URL) |
| AI generation | `src/lib/ai/index.ts` → `router.ts` → `gemini.ts` / `groq.ts`, prompts in `prompts.ts` |

## Upload flow

PDFs never pass through a Next.js function body (Vercel caps request bodies at 4.5 MB):

1. `requestDocumentUpload` validates input (Zod: UUID project, ≤ 50 MB, `application/pdf`, `.pdf`),
   inserts a `documents` row with status `pending_upload`. The DB derives `storage_path`.
2. The server creates a signed upload URL for exactly that path (storage RLS requires a matching
   pending document owned by the caller).
3. The browser uploads directly to private storage.
4. `finalizeDocumentUpload` re-checks ownership, then verifies object size and the `%PDF-`
   signature (first 1 KB via a short-lived signed URL). Pass → `uploaded`; fail → object removed,
   status `failed`.

`uploaded` means *stored and verified*. The uploader then calls `processDocument`, which runs the
ingestion pipeline (see `docs/RAG.md`) and moves the document to `ready` (shown as “Indexed”) or
`failed` with a user-safe reason. Failures are reported per stage (initialization, upload,
validation, processing); a processing failure leaves the verified upload in place with a Retry.

## RAG engine

```
processDocument ─► claim (service role, owner-filtered) ─► download (user client, storage RLS)
  ─► pdf.js + layout ─► chunker ─► gemini-embedding-2 (768) ─► replace_document_chunks (atomic)

askResearchQuestion ─► scope (RLS) ─► embed query ─► match_document_chunks ∥ search_document_chunks_lexical
  ─► RRF ─► dedupe ─► LLM grader ─► sufficiency gate ─► neighbour expansion ─► grounded answer ─► citation validation
```

Modules: `src/lib/rag/{pdf/*,chunker,embeddings,ingest,retrieval,sufficiency,citations,pipeline}.ts`
are framework-free and dependency-injected (unit-tested, reusable by a future queue worker);
`src/lib/rag/{server,ai,store-supabase}.ts` are the `server-only` wiring. UI: `/chat`.

## Rendering model

`cacheComponents` is enabled (Next 16 default direction). Every session/data read sits inside a
`<Suspense>` boundary; static chrome is prerendered and private data streams per request. No
private data is placed in `use cache` scopes.

## AI provider layer

- `generateResearchResponse` / `generateStructuredResponse` are the only entry points.
- Order: `GEMINI_MODEL` (2 retries, exponential backoff) → `GEMINI_FALLBACK_MODEL` (1 retry) →
  `GROQ_MODEL` (1 retry). Retries only for 408/429/5xx/network/timeout; 401/403 skip the whole
  provider; 400/404/422 skip to the next target without retry.
- Gemini uses the Interactions API (`POST /v1beta/interactions`, `store: false`). Only
  `model_output` steps are returned; `thought` steps are discarded. Groq uses
  `include_reasoning: false`.
- Structured output: Gemini `response_mime_type: application/json` + `response_format: <JSON Schema>`;
  Groq `response_format: json_schema` (strict). Output is Zod-validated; invalid JSON falls through
  to the next provider.
- Metadata returned/logged: requested vs actual provider/model, fallback flag, latency, token
  usage, per-attempt error kinds. Never prompts, evidence or outputs.

## Schema decisions

| Table | Status | Why |
|---|---|---|
| `profiles` | created | display name; auto-created by trigger on signup |
| `projects` | created | scoping unit for documents and retrieval |
| `documents` | created | file metadata, lifecycle status, derived storage path |
| `document_chunks` | created | `vector(768)` HNSW (cosine) + generated `tsvector` GIN; `embedding_model`, `section_kind`, `content_type`; read-only for users, written only via `replace_document_chunks` |
| `conversations`, `messages` | deferred | Research Chat works without persistence for now (history is per browser session) |
| `claims`, `claim_evidence` | deferred | added with Claim Verification; `claim_evidence` will FK to `document_chunks` |

Ownership integrity uses composite foreign keys: `documents(project_id, owner_id) → projects(id, owner_id)`
and `document_chunks(document_id, owner_id) → documents(id, owner_id)`, so a row can never reference
another user's parent even if application code is wrong.

Retrieval entry points: `public.match_document_chunks(…)` (dense) and
`public.search_document_chunks_lexical(…)` (full-text) — both `SECURITY INVOKER`, mandatory project
scope, explicit `owner_id = auth.uid()` on top of RLS. Ingestion: `claim_document_for_processing` and
`replace_document_chunks`, executable by `service_role` only.

Service-role privileges are granted explicitly and minimally (`documents`: SELECT/UPDATE;
`document_chunks`: SELECT/INSERT/DELETE) because this project's default privileges give API roles
no DML on new tables (`20261107000004_service_role_grants.sql`).
