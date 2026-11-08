# ADR 0006 — Reranking: no local cross-encoder in the request path; LLM grader kept as the sufficiency judge

**Context.** Milestone 2's LLM relevance grader costs one LLM request per question and is quota-sensitive. Milestone 3 benchmarked free local cross-encoders (joint query+passage scoring, ONNX int8, Node) on the 13-paper benchmark: Gemini dense retrieval, 40-candidate pool, 45 questions.

| reranker | licence | size | R@1 | R@3 | R@5 | R@10 | MRR | nDCG@5 | wrong-doc@5 | latency p50 / p95 (Apple M2 CPU) |
|---|---|---|---|---|---|---|---|---|---|---|
| none (dense order) | — | — | 0.452 | **0.798** | **0.898** | **0.943** | 0.685 | 0.640 | **0.080** | — |
| ms-marco-MiniLM-L-6-v2 | Apache-2.0 | 23 MB | 0.324 | 0.554 | 0.670 | 0.848 | 0.527 | 0.453 | 0.156 | 1.4 s / 2.0 s |
| bge-reranker-base | MIT | 279 MB | 0.428 | 0.656 | 0.748 | 0.937 | 0.623 | 0.571 | 0.138 | 8.0 s / 11.1 s |
| bge-reranker-v2-m3 | Apache-2.0 | 571 MB | **0.557** | 0.757 | 0.830 | 0.865 | **0.735** | **0.643** | 0.133 | 23.2 s / 29.8 s |
| LLM grader (production baseline, Groq gpt-oss-20b, 16-candidate pool) | API | — | see eval/results/lab/rerank-* (LLM run) | | | | | | | 1 LLM request / question |

**Findings.**
- MS-MARCO-trained small cross-encoders *hurt* ranking on scientific text (domain mismatch).
- bge-reranker-v2-m3 is the only one that helps top-1 precision (+23 % R@1, +7 % MRR) but it loses recall at 5/10 and costs ~23 s per query on CPU — unusable in an interactive request path, impossible on Vercel.

**Decision.**
- Production keeps dense order for recall and the LLM grader for the evidence-sufficiency decision (abstention needs a relevance *judgment*, not only an ordering). The grader's input is budgeted (~18k chars) so it also fits the smallest fallback model.
- Cross-encoders stay behind the `RerankFn` interface and in the evaluation lab. bge-reranker-v2-m3 is the candidate if a GPU worker becomes available (expected ~100 ms/query); it would then run in the document-intelligence worker tier, not in Vercel.
- Rerank results are cached per user/project/query/candidate set to avoid repeated LLM calls.

**Reconsider when** a GPU worker exists, or a domain-tuned reranker beats dense order on R@5 and MRR simultaneously on this benchmark.
