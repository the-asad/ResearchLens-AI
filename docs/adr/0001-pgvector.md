# ADR 0001 — Vectors in Postgres (pgvector), not a dedicated vector database

**Context.** Evidence must be retrievable per user and per project with no cross-tenant leakage. Workspace scale target: 10–15 papers (~1–2k chunks); measured corpus: 13 papers, 782 chunks.

**Alternatives.** Pinecone / Qdrant / Weaviate (managed or self-hosted vector DBs); pgvector in the existing Supabase Postgres.

**Decision.** pgvector (HNSW, cosine) + PostgreSQL full-text search in the same tables.

**Why.**
- Tenant isolation is enforced by the *same* Row Level Security that protects documents; retrieval SQL functions are `SECURITY INVOKER` with an explicit `owner_id = auth.uid()` filter. A separate vector store would need its own, duplicated authorization model and a sync pipeline — a second place for leaks.
- Atomic chunk replacement (`replace_document_chunks`) updates vectors, text and document status in one transaction; no eventual consistency between two stores.
- Scale is tiny for pgvector: 782 × 768-d float vectors ≈ 2.4 MB; dense retrieval p50 in the lab ≈ 1 ms in-memory, ~150–200 ms per SQL round trip over the network.

**Trade-offs.** Fewer built-in features (hybrid ranking, rerank hooks) than dedicated engines; HNSW + filters needs `iterative_scan` (set on the function).

**Reconsider when** a workspace exceeds ~1M chunks, or multi-region / very high QPS is required.
