# ADR 0004 — Chunking: keep section-aware 350/600/60 in production; parent-child is the next candidate

**Context.** Milestone 2 chose section → paragraph → sentence chunking (target 350, max 600, overlap 60 only at intra-paragraph splits) a priori. Milestone 3 ran a controlled ablation on the 13-paper benchmark. Because Gemini's free tier cannot re-embed 7 strategies (~25 chunks/min, ~1k items/day), the ablation uses the local **bge-base-en-v1.5** model: absolute numbers are lower than with Gemini; the *relative* ordering is the result.

| strategy (dense, bge-base) | units | MRR | R@1 | R@5 | R@10 | nDCG@5 | context returned (top 5) | vector MB |
|---|---|---|---|---|---|---|---|---|
| parent-child (≈100-token sentence-window children → section parents) | 2418 | **0.580** | **0.380** | **0.691** | **0.796** | **0.478** | ~1.7k tok | 7.4 |
| section-aware 350/600/60 (production) | 782 | 0.415 | 0.256 | 0.578 | 0.691 | 0.352 | ~1.4k tok | 2.4 |
| recursive 400 (structure-blind) | 645 | 0.381 | 0.200 | 0.489 | 0.680 | 0.314 | ~1.8k | 2.0 |
| fixed 300 tokens (naive) | 752 | 0.360 | 0.189 | 0.467 | 0.717 | 0.271 | ~1.7k | 2.3 |
| section-aware large 700/1000/100 | 581 | 0.347 | 0.189 | 0.463 | 0.719 | 0.274 | ~1.7k | 1.8 |
| Docling text + structured tables | 834 | 0.352 (0.368 label-fair) | 0.200 | 0.452 | 0.563 | 0.280 | ~1.3k | 2.6 |
Numeric questions only (MRR): parent-child 0.588, Docling+tables 0.402, section_v1 0.315, Docling text 0.250.

**Decision.** Keep section-aware 350/600/60 in production for now. It beats naive, recursive and larger chunks. Parent-child is clearly best here (+40 % MRR at the same returned context) and is the leading candidate, but it is **not adopted yet** because (a) part of its advantage may come from avoiding bge's 512-token truncation, which Gemini (8k context) does not suffer — it must be confirmed with Gemini; and (b) it needs ~3× embeddings, which exceeds Gemini's free daily embedding quota for a 15-paper workspace. The schema already supports it (`parent_chunk_index`).

**Reconsider** immediately after a Gemini parent-child run (one command in the lab once quota resets) or if a local embedding model is adopted.
