# ADR 0009 — Background document intelligence via a database job queue and pull-only workers

**Context.** Docling needs Python, ~1–2 GB RAM and up to minutes per paper (ADR 0002); Vercel functions cannot host it.

**Decision.**
```
Next.js (auth, UI, phase-1 pdf.js ingestion) ──insert──► ingestion_jobs (RLS: owner can read)
Python docintel worker ──claim (SKIP LOCKED)──► Docling → research-derived/{owner}/{project}/{doc}/derived/*
                        └──insert──► index job
Node indexer worker ──claim──► multimodal units → embeddings (reuse by hash) → replace_document_chunks (atomic)
```
- Workers **pull** jobs (`claim_ingestion_job`, service role only); they expose no HTTP endpoint → no new inbound attack surface.
- Workers re-read the document by id **and owner** and require every path to start with `{owner}/{project}/{document}/`; derived files go to a private bucket with **no user policies** — users reach them only through an owner-checked route that issues 60-second signed URLs.
- Jobs retry up to 3 attempts; stale running jobs are reclaimed after 20 min; a failed phase 2 returns the document to `ready` with its phase-1 chunks intact.
- Chunking and embedding stay in TypeScript (one implementation shared with the app).

**Alternatives.** Calling the Python service over HTTP from the app (inbound endpoint + shared secret; ties request latency to minutes-long jobs); doing everything in Python (two chunker/embedder implementations); a hosted queue (Redis/SQS: another service with no benefit at this scale).

**Reconsider when** throughput needs many workers across machines (still fine with SKIP LOCKED) or jobs need priorities/scheduling beyond FIFO.
