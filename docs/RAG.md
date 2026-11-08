# RAG engine

ResearchLens answers research questions **only** from the user's own processed papers, cites
every claim to a page, and abstains when the evidence does not support an answer. This document
describes the pipeline as implemented, the reasons behind each choice, how it is evaluated, and
what it cannot do yet.

```
private PDF ─► pdf.js text layer ─► layout reconstruction ─► sections/paragraphs
           ─► structure-aware chunks ─► gemini-embedding-2 (768-d) ─► pgvector + tsvector
question   ─► scope check ─► dense ∥ lexical ─► RRF ─► dedupe ─► LLM relevance grader
           ─► sufficiency gate ─► neighbour expansion ─► grounded generation ─► citation validation
```

Code: `src/lib/rag/*` (framework-free, dependency-injected), SQL: `supabase/migrations/20261107000003_rag_engine.sql`.

---

## 1. Ingestion and PDF parsing

**Parser: Mozilla pdf.js via [`unpdf`](https://github.com/unjs/unpdf)** (serverless build), plus
our own layout reconstruction (`src/lib/rag/pdf/`).

Why not PyMuPDF (the usual Python choice)?

| | pdf.js (`unpdf`) | PyMuPDF |
|---|---|---|
| Runtime | Same Node process as Next.js; works on Vercel | Needs a Python service / Python functions |
| License | Apache-2.0 | AGPL-3.0 (or commercial licence) |
| Output | Text runs with position, font size, font name | Richer layout/blocks, generally better tables |
| Measured | 15-page paper parsed in ~0.5–0.9 s | — |

PyMuPDF is stronger on complex layouts and tables; the extractor sits behind one module, so it can
be swapped (or run as a worker) later without touching chunking or retrieval.

**Layout reconstruction** (pure, unit-tested — `layout.ts`):

- Runs → baselines (tolerance scaled by font size) → horizontal segments split at column gutters.
- Sub/superscripts are attached to their line and marked once per run: `d_k`, `10^−9`.
- Two-column pages are read left column then right; full-width lines keep their position.
- Rotated text (e.g. the arXiv margin stamp) is dropped; page numbers and running headers/footers
  (lines in the top/bottom 7 % that are pure numbers or repeat on ≥3 pages) are removed.
- Headings: numbered (`3.2.1 …`, `A.1 …`) with plausibility checks (bold/size/length, rejects table
  rows), known names (Abstract, References, …), or larger font. Font-size-only headings that repeat
  (figure labels) are demoted.
- Paragraph breaks: vertical gaps vs. the median line spacing, indentation, short sentence-final
  lines, column/page changes, captions (`Table 2:` / `Figure 1:`), and switches between numeric
  table rows and prose.
- Normalisation is conservative: ligatures expanded, exotic spaces unified, soft hyphens removed —
  **no NFKC** (it would rewrite ², ℝ, ≤). Line-break hyphens are removed only if the joined word
  occurs elsewhere in the same paper (`transduc-tion` → `transduction`, `position-wise` kept).

**Failure handling** (fail clearly, never invent text): encrypted, unparseable, > 400 pages,
< 200 extractable characters, > 50 % empty pages (likely scanned — OCR not supported), or > 20 %
replacement/private-use glyphs (broken font encoding). Pages without text are recorded.

**Lifecycle**: `uploaded → processing → ready | failed`. `claim_document_for_processing` atomically
claims a verified document (concurrent clicks cannot double-process; stale `processing` > 15 min can
be reclaimed). `replace_document_chunks` deletes and inserts all chunks **and** marks the document
ready in one transaction — a retry never duplicates chunks or exposes a half-written set. Both
functions are executable by `service_role` only; ownership is verified with the user's RLS client
first and the PDF is downloaded with the user's client (storage RLS applies).

## 2. Chunking

`src/lib/rag/chunker.ts` — boundaries in priority order **section → paragraph → sentence**.

1. Blocks are grouped into sections with a heading path (`3 Model Architecture > 3.2 Attention > 3.2.1 …`)
   and a kind: `front_matter`, `abstract`, `body`, `references`, `appendix`.
2. Within a section, prose is packed as one stream and captions / table-like text as another
   (figures float, so prose before and after a figure is one argument).
3. Whole paragraphs are packed greedily up to the target; a chunk may grow to the max so a
   paragraph is not cut. Only paragraphs larger than the max are split, at sentence boundaries
   (abbreviation/decimal/initial-aware splitter), and **only those splits get overlap**.
4. A trailing fragment below the minimum merges into its predecessor in the same section; a tiny
   parent-section intro (e.g. “5 Training: This section describes…”) is folded into its first
   subsection's chunk, recorded as `metadata.merged_parent_intro`.
5. Chunks never cross a section heading.

| Setting | Value | Rationale |
|---|---|---|
| `CHUNK_TARGET_TOKENS` | 350 | ~1–2 research-paper paragraphs (typically 120–300 tokens): one idea per chunk keeps similarity sharp |
| `CHUNK_MAX_TOKENS` | 600 | lets a long paragraph stay whole rather than splitting an argument |
| `CHUNK_OVERLAP_TOKENS` | 60 | ~1–2 sentences, only at intra-paragraph splits (no duplicated whole paragraphs) |
| `CHUNK_MIN_TOKENS` | 80 | avoids meaningless fragments |

Tokens are estimated as characters / 4 (documented estimate, not a tokenizer). These values were
chosen a priori and **were not tuned against the evaluation set**.

Stored per chunk: `document_id, owner_id, project_id, chunk_index, page_start, page_end,
section_title, section_kind, content_type ('text'), content, token_count, embedding,
embedding_model, metadata{section_path, layout: prose|caption|table_like, overlap_tokens}`.
`content_type` already allows `table | figure | note` for future modalities; only `text` is produced.

## 3. Embeddings

`src/lib/rag/embeddings.ts` — provider interface `embedDocuments(texts)` / `embedQuery(text)`.

- **Model: `gemini-embedding-2`**, `outputDimensionality = 768`, `taskType` `RETRIEVAL_DOCUMENT` /
  `RETRIEVAL_QUERY`. Free with the existing Gemini key; GA; 8,192-token input; multimodal (future
  figure embeddings). In a probe it separated relevant from irrelevant text better than
  `gemini-embedding-001` (0.857 vs 0.521 against 0.820 vs 0.530).
- **Dimensions verified, never coerced**: every response must contain exactly 768 finite values per
  input or the batch fails — no truncation, no padding. Vectors are L2-normalised (live check:
  all 42 stored vectors have norm 1.0000). The DB column stays `vector(768)`.
- Batches of 50 inputs (`batchEmbedContents`, limit 100), sequential for bounded concurrency and
  deterministic order; empty and oversized (> 24k chars) inputs rejected up front; 4 retries with
  exponential backoff + jitter for 408/429/5xx/network only; auth errors are not retried.
- **Contextual header**: the embedded text is `Paper: <title>\nSection: <path>\n\n<content>`; the
  stored `content` is the plain chunk.
- Each chunk records `embedding_model`; dense search filters on it, so vectors from different
  models are never compared. Document metadata records model, dimensions, parser, chunker version
  and chunk configuration.

## 4. Dense retrieval

`match_document_chunks(query_embedding, p_project_id, p_embedding_model, p_document_ids, match_count, p_include_references)`

- `SECURITY INVOKER` (RLS applies) **and** explicit `owner_id = auth.uid()`; `project_id` is
  mandatory; optional document filter; references excluded by default; `match_count` capped at 100.
- Cosine distance on an HNSW index. `hnsw.iterative_scan = strict_order` and `ef_search = 100`
  are set on the function so tenant filters cannot starve the index scan (pgvector 0.8).
- Top-K: `RETRIEVAL_DENSE_K = 20`.

## 5. Lexical retrieval

`search_document_chunks_lexical(query_text, p_project_id, p_document_ids, match_count, p_include_references)`

- Stored generated column `search_vector = setweight(to_tsvector('english', section_title), 'A') || setweight(to_tsvector('english', content), 'B')` with a GIN index.
- `plainto/websearch_to_tsquery` AND all terms, which fails for natural-language questions. Instead
  the query is normalised with the **same** `english` config and the resulting lexemes are OR-ed and
  cast directly to `tsquery` (no re-parsing, so `bert-larg`, `f1`, `2.0` stay single lexemes).
  Ranking: `ts_rank_cd(…, 1)` (cover density, length-normalised) — chunks matching more and closer
  query terms rank higher.
- Same tenant scoping as dense. Top-K: `RETRIEVAL_LEXICAL_K = 20`.

## 6. Hybrid fusion (RRF)

`reciprocalRankFusion` in `retrieval.ts`: `score(d) = Σ_r 1 / (k + rank_r(d))`, `k = 60`
(Cormack et al., 2009). RRF uses **ranks**, because cosine similarity and `ts_rank_cd` are on
incomparable scales — adding them would be arbitrary. Ties break on dense rank, then reading order.
Near-duplicates (word 5-gram containment ≥ 0.6) are then removed, keeping the better-ranked chunk.
If query embedding fails, retrieval degrades to lexical-only and the trace says so.

## 7. Reranking

**Temporary reranker: an LLM used as a pointwise relevance grader** (`src/lib/rag/ai.ts`) — it is
**not** a cross-encoder. The top `RERANK_CANDIDATES = 16` fused candidates (each truncated to 2,400
characters) are graded in one structured-output call:

`3` directly states the answer · `2` partial / necessary supporting fact · `1` same topic, does not answer · `0` irrelevant

Passages are sent as delimited untrusted evidence. Output is Zod-validated; unknown ids are ignored.
Kept evidence: grade ≥ 2, sorted by grade then fused rank, top `FINAL_K = 6`. Latency is measured
per call. If the grader is unavailable, the pipeline falls back to fusion order, labels the trace
`fusion_fallback`, and treats sufficiency as `WEAK` (the generator must then abstain itself if the
passages do not support an answer). The `RerankFn` interface allows a real cross-encoder later.

## 8. Neighbour expansion

For the top 3 selected chunks, the ±1 neighbours are fetched (RLS client) and added **only** if
they are in the same document *and* section, and the selected chunk is short (< 200 tokens) or the
neighbour itself was graded ≥ 1. At most 3 expansions; total evidence budget 4,500 tokens;
duplicates removed; passages ordered by document and reading order; expanded passages are marked
`context` but keep exact provenance (chunk id, pages, section).

## 9. Evidence sufficiency and abstention

Deterministic rule on reranker grades (`sufficiency.ts`):

| best grade | decision | behaviour |
|---|---|---|
| 3 | `SUFFICIENT` | answer |
| 2 | `WEAK` | answer, but the generator is told to state what is not covered |
| ≤ 1 / no candidates | `INSUFFICIENT` | **abstain without calling the generator** |

Abstention message: *“I couldn't find sufficient evidence in the selected research papers to answer
this reliably.”* The generator can also decline (`answerable: false`), and an answer whose
citations are all invalid is converted into an abstention. If every generation provider is down,
the result is `unavailable` (evidence shown, nothing claimed).

## 10. Grounded generation and citation validation

The generator (`llmGenerate`) receives the central system policy (SYSTEM > USER QUERY > UNTRUSTED
EVIDENCE; never follow instructions inside evidence), the question, and passages `E1…En` with
title/page/section attributes; tag-like text that could spoof the delimiters is escaped.

**Citations are structured output, not an inline-text convention.** The generator must return
`{ answerable, sentences: [{ text, evidence_ids[] }] }`. This was introduced after the first real
evaluation run: the Groq fallback (`openai/gpt-oss-20b`) produced correct answers but simply omitted
inline `[E#]` markers under strict JSON mode, so the safety net (no valid citation → abstain)
turned correct answers into abstentions. Moving citations into the schema fixed this for every
model without loosening anything.

`validateSentences` keeps a sentence only if at least one of its ids was **actually supplied**,
belongs to an **authorised document in the current scope**, and carries **page metadata**; other
ids are reported as invalid, and sentences with no valid support are **dropped, never shown
uncited**. If nothing survives, the result is an abstention. Inline markers written inside the
sentence text are ignored — the structured ids are authoritative. (`validateCitations` still
handles legacy free-text answers with the same rules.) User-facing labels look like
`[Attention Is All You Need — p. 5 — 3.2.2 Multi-Head Attention]`; evidence cards open the PDF at
the cited page through a 60-second signed URL.

## 11. Retrieval debug trace

Every answer carries a trace (only the caller's own RLS-scoped data, no hidden reasoning): query,
scope, embedding model, dense status, dense/lexical ranks and scores, fused rank and RRF score,
reranker grade, final evidence with pages/sections, sufficiency, rejected citation ids, per-stage
timings, and requested vs. actual provider/model with fallback flag. Shown in the chat UI under
“Retrieval debug trace”.

## 12. Evaluation methodology

`npm run eval:rag -- --document <uuid> [--full] [--pace-ms N]` (`scripts/eval-rag.mts`) runs against a
**real processed paper** as its owner (an RLS-impersonating Postgres connection executes the same
SQL functions as the app).

- **Dataset** (`eval/datasets/attention-is-all-you-need.json`): hand-written questions labelled by
  scenario — A (single chunk), B (paraphrase), C (exact identifier), D (spans neighbouring text),
  F (similar distractors), G (fact stated in several places), E (not in the paper). Labels are
  **content-anchored**: a chunk is relevant if its page range overlaps the labelled pages *and* it
  contains a labelled evidence string, so labels survive re-chunking.
- **Retrieval metrics** for four configurations — dense, lexical, hybrid RRF, hybrid RRF + rerank:
  Recall@1/3/5 (fraction of the question's relevant chunks retrieved), Hit@1/3/5, MRR, nDCG@5.
  The rerank configuration uses the exact graded pool that drove each end-to-end answer and is
  computed only over questions where the grader actually ran.
- **End-to-end**: answer correctness (all expected facts present and ≥1 citation to a relevant
  chunk), abstention accuracy on unanswerable questions, false abstentions, citation validity,
  fabricated-citation count, sufficiency decisions, per-stage latency, requested vs. actual model.
- **Security probes** in the same run: unknown project id, unauthorised document id, and a
  different user against the real project (must retrieve nothing).
- **Rule**: thresholds, RRF `k`, chunk sizes, labels and top-K values are fixed before evaluation and
  are not tuned to these answers. Results are written to `eval/results/`.

Unit tests (`tests/rag/*`) cover the required failure scenarios deterministically: A/C (lexical-only
identifier hits enter fusion), E (abstain without generating), F (only grade ≥ 2 kept), G (dedupe),
H (prompt injection escaped and delimited), I/J (scope rejected before retrieval; foreign rows
discarded), K (empty/corrupt PDF), L (embedding retries, lexical-only degradation, ingestion
marked failed), M (provider fallback, quota circuit breaker, generation outage → `unavailable`).
The live RLS test (`npm run test:rls`) checks cross-tenant dense and lexical retrieval,
embedding-model isolation and service-role-only ingestion functions in the real database.

## 13. Results

Real paper: *Attention Is All You Need* (arXiv 1706.03762, 15 pages) uploaded through the UI and
indexed into 42 chunks (all 768-d, norm 1.0, `gemini-embedding-2`). 13 labelled answerable + 4
unanswerable questions. Full report: `eval/results/2026-11-07T05-44-39-890Z-full.md`.

| configuration | n | Recall@1 | Recall@3 | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|---|---|---|
| A. dense | 13 | 0.872 | 0.897 | 0.974 | 1.000 | 0.956 |
| B. lexical | 13 | 0.487 | 0.744 | 0.821 | 0.731 | 0.696 |
| C. hybrid RRF | 13 | 0.679 | 0.859 | 0.859 | 0.859 | 0.819 |
| D. hybrid RRF + LLM grader | 12* | 0.708 | 0.958 | 1.000 | 0.875 | 0.900 |

\* G1's grader call was rate-limited (fusion fallback), so D is computed over the 12 questions where
the grader actually ran.

**Honest reading.** On this single, small paper dense retrieval is already at ceiling (MRR 1.0), and
**equal-weight RRF made ranking worse than dense alone** (MRR 0.859, Recall@1 0.679): the OR-of-
lexemes lexical query matches many chunks in a 42-chunk corpus, and chunks that appear mid-list in
both rankings overtake a chunk that is #1 in dense only (B2: dense 1, lexical 12 → hybrid 6). The
grader recovers most of that (Recall@5 1.0, MRR 0.875) but **still does not beat dense alone on MRR**.
Lexical retrieval's value (exact identifiers like `warmup_steps`, `P_drop`) is not visible here
because dense also finds them in such a small corpus; it needs a multi-paper evaluation. RRF `k`,
weights and K values were deliberately **not** tuned against these labels.

End-to-end (grader and generator were both served by the Groq fallback `openai/gpt-oss-20b`, because
the Gemini free tier — 20 requests/day/model — was exhausted):

- 11/13 answerable questions passed the automatic check (expected facts present + cited);
  12/13 cited a labelled-relevant chunk. Failures: **C2** — every generation provider was
  rate-limited, result `unavailable` (no claim made); **F1** — the answer was correct but used a
  non-breaking hyphen (“Dot‑product”), so the string check failed (scorer artifact, left as reported).
- 0/13 false abstentions; **4/4 correct abstentions** on unanswerable questions (all gated as
  `INSUFFICIENT` before generation).
- 20 citations returned, all validated; **0 fabricated ids** produced.
- Sufficiency: 12 SUFFICIENT · 1 WEAK · 4 INSUFFICIENT.
- Latency (p50): query embedding ~1.1 s, rerank ~1.5 s, generation ~0.8 s, total ~7.4 s. SQL stages
  in the harness are inflated (~1–2 s) because each impersonated query makes five round trips
  (begin / role / claims / query / commit); one outlier (A4) stalled ~92 s on that harness Postgres
  connection, not in an LLM stage.
- Security probes against the real data: unknown project, unauthorised document id, and a different
  user all retrieved nothing.

An earlier run on the same day (before the structured-citation fix) produced three false
abstentions from the same root cause and was stopped; it is not used for the numbers above.


## 14. Limitations (honest)

- **Text only.** Tables are linearised text (`layout: table_like`), often with scrambled cell
  order; figures, equations rendered as glyph soup, handwritten notes and scanned PDFs (no OCR) are
  not understood. `content_type` is always `text`.
- **Reranker is an LLM grader**, not a cross-encoder: slower, costs quota, and its grades can vary
  between calls/models. When it is unavailable the pipeline falls back to fusion order.
- **Equal-weight RRF underperformed dense-only on the one evaluated paper.** Weighted fusion or
  query-dependent lexical weighting should be evaluated on a larger, multi-paper, held-out set
  before changing defaults.
- **Free-tier quotas dominate behaviour.** Gemini free tier allows ~20 requests/day per model; Groq
  allows 8k tokens/minute. Each question costs 1 embedding + 2 LLM calls. Quota-exhausted models are
  skipped via a per-instance circuit breaker, and answers may come from the Groq fallback.
- Token counts are estimates (chars/4). The sufficiency gate depends on reranker grades.
- Ingestion runs synchronously inside the request (fine for typical papers: ~3–6 s here) — large
  batches should move to a queue worker; the ingestion module is already framework-free.
- The evaluation set is one paper and 17 questions, labelled by the implementer: useful for
  regressions and diagnosis, not a benchmark.
- No conversation persistence yet (chat history lives in the browser session).

---

# Milestone 3 — multi-paper benchmark, ablations and multimodal evidence

Decisions are recorded as ADRs in [`docs/adr/`](adr). This section summarises what was measured.

## Benchmark
- **Corpus** (`eval/corpus/manifest.json`, downloaded by `scripts/download-corpus.mts`, PDFs git-ignored):
  13 arXiv papers on transformer pre-training and efficient attention (Transformer, BERT, Transformer-XL,
  XLNet, RoBERTa, ALBERT, DistilBERT, T5, Reformer, ELECTRA, Longformer, Linformer, Performer) —
  268 pages, 782 production chunks; overlapping terminology, an explicit disagreement (next-sentence
  prediction), two-column layouts, a 67-page paper, table- and figure-heavy papers.
- **Questions** (`eval/datasets/multi-paper-v1.json`): 50 (factual 8, numeric 6, paraphrase 5, identifier 5,
  methodology 5, which-paper 4, compare 4, confusable 3, multi-evidence 2, adversarial 2, conflict 1,
  unanswerable 5). Labels name paper + page + evidence phrase found by reading the source, never
  retriever output; `scripts/lab/validate-labels.mts` checks every group matches its page. 8 questions
  require evidence from 2–4 papers; Recall@K is the share of required evidence groups found in the top K.
- Internal benchmark, written by the implementer — useful for comparisons and regressions, not a
  public leaderboard.

## Results (Gemini vectors unless noted)
| experiment | headline | ADR |
|---|---|---|
| embeddings | gemini-embedding-2 MRR 0.685 / R@5 0.898; best open model (bge-base, e5-base) MRR ≈ 0.42 | 0003 |
| retrieval | dense best on recall (R@5 0.898); equal RRF 0.759; weighted/adaptive +R@1, −R@5 | 0005 |
| rerankers | MiniLM and bge-base hurt; bge-v2-m3 +R@1 (0.557) but −R@5 and 23 s/query on CPU | 0006 |
| chunking (bge-base) | parent-child MRR 0.580 vs production 0.415; naive/large chunks worse | 0004 |
| parsers | pdf.js scrambles two-column reading order (41–64 % intact) yet Docling prose did not retrieve better; Docling tables help numeric questions | 0002 |
| OCR | clean/rotated scans 94–99.7 % word recall; degraded excluded by confidence gate (31–34 < 60) | 0007 |
| scaling (1→13 papers) | fixed BERT question set: MRR 0.806 → 0.639, wrong-doc@5 0 → 0.33, R@5 stays 1.0 | — |
| LLM grader | ~5.5k tokens per question; Groq daily quota exhausted after 10/45 questions | 0006, 0008 |

## Engine changes in this milestone
- **Two-phase ingestion** (ADR 0002, 0009): pdf.js text in-process; Docling worker adds structured
  tables, captioned figures (+ PNG crops in a private bucket) and OCR for pages without a text layer.
  Phase-1 prose chunks and embeddings are kept; a failed phase 2 leaves the paper `ready`.
- **Evidence model**: `content_type` text / table / figure / graph / equation / ocr_text /
  handwritten_note / image_note, with `bbox`, `structured` (table cells), `derivation`,
  `source_asset_path`, `confidence`, `embedding_modality`, `parent_chunk_index`.
- **Numeric fidelity**: every number in an answer sentence must appear in a passage that sentence
  cites, otherwise the sentence is dropped (`numericViolations` in the trace).
- **Cross-paper questions**: deterministic query analysis detects comparison / "which papers"
  intent; evidence is selected round-robin across papers and sufficiency requires relevant evidence
  from ≥ 2 papers (else WEAK, "evidence found in only one paper").
- **Quota resilience**: provider catalog + health registry (quota skip, cooldown), embedding pacing,
  daily-quota fail-fast, budgeted grader input, per-user caches, per-question usage accounting.
- **Notes**: private `research-notes` bucket, PNG/JPEG/WebP with magic-byte checks, forced OCR in the
  worker, `handwritten_note` evidence with confidence.

## Not done / not verified (honest)
- **Handwriting** accuracy: pipeline built; needs the user's real note photos (not yet uploaded).
- **Figure understanding beyond captions**: no vision description yet (Gemini vision quota: 20
  requests/day/model). Figures are retrievable by caption and shown as image crops only.
- **Multimodal embeddings** (gemini-embedding-2 image input): not evaluated (embedding quota exhausted).
- **Parent-child with Gemini**, **Docling+tables with Gemini**, **LLM-grader baseline on all 45
  questions**: blocked by free-tier daily quotas on the benchmark day.
- **End-to-end phase 2 on a user upload through the UI**: workers run locally; awaiting a UI
  "Reprocess" and note uploads (and the Gemini embedding quota reset).
