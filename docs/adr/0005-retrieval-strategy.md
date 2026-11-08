# ADR 0005 — Dense-first retrieval; lexical as candidate expansion, not rank fusion

**Context.** Milestone 2 (one paper) showed equal-weight RRF hurting ranking. Re-tested on 13 papers with Gemini vectors and production chunks (eval/results/lab/retrieval-*.json).

| strategy | R@1 | R@5 | R@10 | MRR | nDCG@5 | wrong-doc@5 |
|---|---|---|---|---|---|---|
| dense | 0.452 | **0.898** | **0.943** | 0.685 | **0.640** | **0.080** |
| lexical (production OR-of-lexemes ts_rank_cd) | 0.167 | 0.548 | 0.700 | 0.347 | 0.265 | 0.458 |
| BM25 (in-memory comparison arm) | 0.291 | 0.635 | 0.748 | 0.496 | 0.416 | 0.324 |
| RRF (equal) | 0.435 | 0.759 | 0.865 | 0.653 | 0.538 | 0.124 |
| weighted RRF (lexical 0.5) | 0.502 | 0.787 | 0.887 | 0.699 | 0.589 | 0.102 |
| adaptive (deterministic query features → weights) | **0.507** | 0.776 | 0.904 | **0.699** | 0.590 | 0.093 |

Per query kind (MRR): identifier queries — dense 0.565, adaptive 0.527, adaptive+BM25 0.593; semantic — dense 0.750, adaptive 0.809. With 17/21 questions per kind these differences are within noise.

**Decision.** Dense retrieval is the primary ranking. No fusion strategy reliably beat it on recall (R@5 drops 0.90 → 0.76–0.83). Lexical search is kept for exact-identifier recall but used to **add candidates** to a reranker pool rather than to fuse ranks. Adaptive weights are kept in code (`query-features.ts`, deterministic, no LLM) but are not the default because their R@1 gain costs R@5.

**Trade-off.** Exact-identifier questions rely on the reranker seeing lexical candidates.

**Reconsider when** the benchmark grows (more identifier-heavy questions, more papers) or a better lexical ranker (BM25 in Postgres) is available.
