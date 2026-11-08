# ADR 0003 — Embedding model: keep gemini-embedding-2 (768-d)

**Context.** Milestone 2 picked gemini-embedding-2 without a benchmark. Milestone 3 benchmarked it against free/open alternatives on the 13-paper corpus (45 answerable questions, dense retrieval only, production chunks).

**Results (eval/results/lab/embeddings-*.json).**
| model | dims | ctx | licence | R@1 | R@3 | R@5 | R@10 | MRR | nDCG@5 | nDCG@10 | wrong-doc@5 | query embed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gemini-embedding-2 | 768 | 8192 | API (free tier) | **0.452** | **0.798** | **0.898** | **0.943** | **0.685** | **0.640** | **0.684** | **0.080** | ~612 ms (API) |
| bge-base-en-v1.5 (int8 ONNX) | 768 | 512 | MIT | 0.256 | 0.489 | 0.578 | 0.691 | 0.415 | 0.352 | 0.405 | 0.187 | ~38 ms local |
| e5-base-v2 (int8) | 768 | 512 | MIT | 0.211 | 0.513 | 0.580 | 0.659 | 0.418 | 0.344 | 0.386 | 0.173 | ~40 ms |
| nomic-embed-text-v1.5 (int8) | 768 | 8192 | Apache-2.0 | 0.189 | 0.400 | 0.550 | 0.624 | 0.363 | 0.309 | 0.347 | 0.164 | ~33 ms |
| bge-small-en-v1.5 (int8) | 384 | 512 | MIT | 0.156 | 0.311 | 0.511 | 0.646 | 0.337 | 0.283 | 0.336 | 0.164 | ~18 ms |
Recall@K = share of a question's required evidence groups found in the top K.

**Decision.** Keep gemini-embedding-2 for production. The quality gap (MRR 0.685 vs ≤ 0.418) is far larger than question-sampling noise (split-half MRR 0.725/0.644). Nomic has an 8k context yet also scores low, so 512-token truncation is not the main cause; int8 quantisation may cost some quality (not isolated here).

**Costs we accept and mitigate.** Free tier counts every batch item as a request (100/min/model) and real throughput was ~20–25 chunks/min, so indexing a 15-paper workspace takes ~40–60 min. Mitigations: per-model pacer (90 items/min) + `retryDelay` honouring (no failed ingestions), embedding reuse by content hash on re-index, query-embedding cache. Vectors from different models never share a search (`embedding_model` filter).

**Reconsider when** a paid tier is acceptable (no throughput issue), or an open model evaluated in fp32/fp16 on this benchmark closes the gap — the provider interface and lab make that a one-command experiment.
