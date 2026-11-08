# Development

## Prerequisites
Node.js 20+ (tested with 26), npm, `psql` (optional, for migrations/RLS tests).

## Setup
```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000
```

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit + static security tests (no network) |
| `npm run test:rls` | RLS isolation test against `DATABASE_URL` (transaction rolled back) |
| `npm run test:ai-live` | Live Gemini/Groq smoke test (real API calls) |
| `npm run eval:rag -- --document <uuid> [--full] [--pace-ms 70000]` | RAG evaluation on a processed paper (see `docs/RAG.md`) |
| `npm run inspect:pdf -- file.pdf` / `inspect:chunks` | Print extracted structure / chunks of a local PDF |

Free-tier note: Gemini allows ~20 generation requests/day per model and Groq 8k tokens/minute;
`--full` makes 2 LLM calls per question, so pace it (`--pace-ms`) when Gemini quota is exhausted.

## Database migrations
SQL lives in `supabase/migrations/` and is the source of truth. Apply with the Supabase CLI
(`npx supabase link --project-ref <ref> && npx supabase db push`) or with psql:
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/<file>.sql
```
Applied migrations are recorded in `supabase_migrations.schema_migrations` so the CLI will not
re-apply them. If `DATABASE_URL`'s password contains `@`, `:` or `/`, URL-encode it.

## Supabase dashboard settings
- Auth → URL Configuration: Site URL = `NEXT_PUBLIC_APP_URL`; add
  `http://localhost:3000/auth/callback` and your production `/auth/callback` to Redirect URLs.
- Storage → `research-papers` must stay **private**.

## Conventions
- Data reads in pages go inside `<Suspense>` (Cache Components) and start with `requireUser()`.
- Use the user-scoped server client for all data access; the admin client only for
  server-owned state transitions, always with an explicit `owner_id` filter.
- Validate every action input with Zod (`src/lib/validation.ts`).
- Never log document text, prompts, outputs, or credentials.

## Document-intelligence workers (Milestone 3)

Phase 1 (pdf.js) runs inside the app. Phase 2 (layout, structured tables, figures, OCR) needs two
background workers. Both read secrets from the environment only.

```bash
# one-time: Python 3.12+ venv with pinned worker deps (+ Tesseract for OCR: brew install tesseract)
python3 -m venv services/docintel/.venv && services/docintel/.venv/bin/pip install -r services/docintel/requirements.txt
```
```bash
set -a; source .env.local; set +a; services/docintel/.venv/bin/python services/docintel/worker.py
```
```bash
npx tsx --conditions=react-server --env-file=.env.local scripts/index-worker.mts
```
Without the workers, papers stay searchable at phase-1 quality; notes and scanned PDFs wait in the
queue.

## Evaluation lab (offline, public corpus only)
```bash
npx tsx scripts/download-corpus.mts                 # 13 arXiv papers → eval/papers (git-ignored)
npx tsx scripts/corpus-parse-report.mts             # pdf.js extraction cache + stats
scripts/docling-corpus.sh                           # Docling extraction cache
psql "$DATABASE_URL" -f supabase/lab/eval_lab.sql    # isolated lexical-search schema (no API access)
npx tsx scripts/lab/validate-labels.mts             # labels match source pages
npx tsx --env-file=.env.local scripts/lab/run.mts --exp embeddings|chunking|retrieval|rerank|scaling
```
Results land in `eval/results/lab/` (JSON + Markdown). Embeddings are cached in `eval/cache/emb/`.
Open embedding / reranker models (ONNX int8) are downloaded from Hugging Face on first use into
`eval/cache/hf/` (git-ignored, ~1.3 GB). Synthetic scans for OCR tests:
`services/docintel/.venv/bin/python services/docintel/make_scans.py eval/papers/distilbert.pdf eval/scans`
(then `scripts/lab/ocr-eval.mts`). **The lab's Gemini runs consume free-tier quota** — the embeddings
experiment alone uses most of a day's embedding quota; local-model experiments use none.

## Platform prerequisites a fresh Supabase project already provides
Migrations assume the standard Supabase platform: `auth.users` / `auth.uid()`, the `storage` schema,
the `extensions` schema with `vector` available, and the `anon` / `authenticated` / `service_role`
roles with USAGE on `extensions`. Verified on 2026-11-08 by applying all migrations in order to an
empty database on the same cluster (with minimal auth/storage stand-ins): the resulting schema,
functions, policies and grants matched the live project exactly and `supabase/tests/rls_isolation.sql`
passed.
