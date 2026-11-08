# ResearchLens AI

**Evidence-Grounded Multimodal Research Intelligence and Claim Verification Platform.**

Next.js 16 · TypeScript · Tailwind CSS 4 · Supabase (Auth, Postgres + pgvector, Storage) ·
Gemini Interactions API with Groq fallback · Zod.

## Status (Milestone 3 — multi-paper benchmark, ablations, multimodal evidence)

| Area | State |
|---|---|
| Email/password auth, protected routes, sign-out | ✅ |
| Projects (create/list/delete) | ✅ |
| Private PDF upload with server-side verification, list, view, delete | ✅ |
| RLS schema, storage policies, tenant-scoped vector search function | ✅ (applied + tested) |
| AI provider layer (Gemini → fallback → Groq, quota circuit breaker, structured output) | ✅ |
| Text RAG: pdf.js parsing, structure-aware chunks, gemini-embedding-2, hybrid dense+lexical RRF, LLM grader, sufficiency gate, validated citations | ✅ (see `docs/RAG.md`) |
| Research Chat with evidence cards + retrieval debug trace | ✅ |
| Evaluation harness (Recall@K, MRR, nDCG, abstention, citation validity) | ✅ `npm run eval:rag` |
| 13-paper benchmark + evaluation lab (embeddings, chunking, retrieval, rerankers, scaling) | ✅ `scripts/lab/run.mts`, ADRs in `docs/adr/` |
| Docling worker: structured tables, figure crops, OCR with confidence gate (scans tested) | ✅ built & benchmarked; UI end-to-end pending |
| Research notes (images) upload + OCR path | ✅ built; handwriting accuracy untested (needs real photos) |
| Figure vision descriptions, multimodal embeddings, claim verification, insights | ❌ not done |

See `docs/ARCHITECTURE.md`, `docs/RAG.md`, `docs/SECURITY.md`, `docs/DEVELOPMENT.md`.
