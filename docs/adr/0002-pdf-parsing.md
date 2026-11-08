# ADR 0002 — Two-phase parsing: pdf.js (fast) + Docling worker (layout, tables, figures, OCR)

**Context.** Milestone 2 used pdf.js (`unpdf`) with our own layout reconstruction. The 13-paper benchmark exposed its limits.

**Evidence (eval/results/lab/parser-compare.json, scans: scripts/lab/ocr-eval.mts).**
| | pdf.js (+ our layout) | Docling (layout model) |
|---|---|---|
| Reading order, two-column papers (share of Docling sentence windows found intact) | BERT 64 %, RoBERTa 41 %, Longformer 53 % (single-column papers 89–100 %) | correct (by construction of the probe; verified by inspection) |
| Root cause | pdf.js emits **text runs that cross the column gutter** (one run x=72→440 on BERT p.3) — cannot be fixed downstream | layout model segments regions |
| Tables | linearised, cells scrambled | structured grid; BERT Table 1 (GLUE) 6×10 cells all correct; multi-row headers detected |
| Figures | caption text only | caption + bbox + PNG crop |
| Inline math (Reformer/Linformer label phrases) | 7/7, 6/6 | 4/7, 4/6 (formulas emitted differently) |
| Scanned PDF | rejected (correctly, no invented text) | OCR: clean 94–99 % word recall, rotated 94–99.7 %, degraded 0–17 % (gated, see ADR 0007) |
| Mixed digital + scanned | accepted but **scanned page silently missing** | all pages recovered (96–99.5 %) |
| Cost | 0.04–0.95 s / paper, in-process | 8–77 s / paper (CPU), 0.8–1.7 GB RSS, Python + torch (~1.5 GB install) |

**Retrieval check (label-fair, 43 questions, bge-base; ADR 0004).** Docling *prose* chunks did **not** retrieve better than pdf.js section chunks (dense MRR 0.351–0.368 vs 0.421), despite the correct reading order — the benchmark's questions are mostly answerable from passages pdf.js keeps intact. Structured table units did help numeric questions (MRR 0.402 vs 0.315).

**Decision.** Keep pdf.js as **phase 1** (seconds, in the Next.js process, always available). Run Docling as **phase 2** in a separate Python worker, **additively**: phase-1 prose chunks (and their embeddings) are kept for digital pages; Docling contributes OCR prose for pages without a text layer, structured table units and figure units. If the worker is not running, papers remain searchable at phase-1 quality.

**Alternatives considered.** PyMuPDF (AGPL-3.0 licence; no table structure model), GROBID (strong for references/header metadata, Java service, weaker for tables), marker / nougat (GPU-oriented, heavier), cloud document AI (paid). Docling: MIT licence, tables via TableFormer, figures, OCR integration, runs on CPU.

**Trade-offs.** A second runtime (Python) and a job queue; 1–2 GB RAM per worker; minutes per large paper on CPU.

**Reconsider when** a Node-native layout model reaches comparable table/reading-order quality, or GPU workers make heavier models (marker/nougat) affordable.
