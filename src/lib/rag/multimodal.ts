/**
 * Build multimodal evidence units from the document-intelligence result (pure, unit-tested):
 *   prose  → production chunker over layout-model reading order (OCR provenance preserved)
 *   tables → one unit per table: structured cells + caption + bbox; text form keeps row/column semantics
 *   figures → one unit per captioned figure: caption (+ optional, labelled vision description) + image asset
 */
import { chunkBlocks, embeddingText, estimateTokens, type ChunkConfig, defaultChunkConfig } from "./chunker";
import { docIntelToBlocks, figureToText, tableToText, unreadableOcrPages, type DocIntelResult } from "./docintel";
import type { ContentType } from "@/lib/database.types";

export type EvidenceUnit = {
  chunkIndex: number;
  contentType: ContentType;
  derivation: "pdf_text" | "layout_model" | "ocr" | "vision" | "table_model";
  content: string;
  embedText: string;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  sectionKind: string;
  tokenEstimate: number;
  bbox: number[] | null;
  structured: Record<string, unknown> | null;
  sourceAssetPath: string | null;
  confidence: number | null;
  metadata: Record<string, unknown>;
};

/**
 * `prose: "ocr_only"` (default for papers that already have phase-1 text chunks): Docling prose is
 * used ONLY for pages without a text layer; digital-text prose keeps its pdf.js chunks. Measured on
 * the 13-paper benchmark: Docling prose did not retrieve better than pdf.js section chunks
 * (label-fair dense MRR 0.36 vs 0.42), while Docling tables/figures/OCR add evidence pdf.js lacks.
 */
export function buildEvidenceUnits(r: DocIntelResult, title: string | null, opts: { kind: "paper" | "note"; cfg?: ChunkConfig; prose?: "all" | "ocr_only" } = { kind: "paper" }): {
  units: EvidenceUnit[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const unreadable = unreadableOcrPages(r);
  if (unreadable.length) warnings.push(`OCR too unreliable to index on page(s) ${unreadable.map((p) => `${p.page} (conf ${p.confidence ?? "?"})`).join(", ")}`);
  const ocrConfidence = new Map((r.pages ?? []).filter((p) => p.ocr && p.ocrConfidence != null).map((p) => [p.page, p.ocrConfidence! / 100]));

  const units: EvidenceUnit[] = [];
  const ocrPages = new Set((r.pages ?? []).filter((p) => p.ocr).map((p) => p.page));
  const blocks = docIntelToBlocks(r).filter((b) => opts.prose !== "ocr_only" || ocrPages.has(b.page));
  for (const c of chunkBlocks(blocks, opts.cfg ?? defaultChunkConfig)) {
    const pageConf = [...Array(c.pageEnd - c.pageStart + 1)].map((_, i) => ocrConfidence.get(c.pageStart + i)).filter((x): x is number => x != null);
    const contentType: ContentType = opts.kind === "note" ? "handwritten_note" : c.ocr ? "ocr_text" : "text";
    units.push({
      chunkIndex: units.length, contentType, derivation: c.ocr || opts.kind === "note" ? "ocr" : "layout_model",
      content: c.content, embedText: embeddingText(title, c), pageStart: c.pageStart, pageEnd: c.pageEnd,
      sectionTitle: c.sectionPath.at(-1) ?? null, sectionKind: c.sectionKind, tokenEstimate: c.tokenEstimate,
      bbox: null, structured: null, sourceAssetPath: null,
      confidence: pageConf.length ? Math.min(...pageConf) : null,
      metadata: { section_path: c.sectionPath, layout: c.layout, overlap_tokens: c.overlapTokens, ...(c.ocr ? { ocr: true } : {}) },
    });
  }

  for (const t of r.tables) {
    if (t.page == null || t.rows.length < 2) continue;
    const content = tableToText(t);
    units.push({
      chunkIndex: units.length, contentType: "table", derivation: "table_model", content,
      embedText: `${title ? `Paper: ${title}\n` : ""}${content}`, pageStart: t.page, pageEnd: t.page,
      sectionTitle: t.caption?.slice(0, 120) ?? `Table ${t.index + 1}`, sectionKind: "body", tokenEstimate: estimateTokens(content),
      bbox: t.bbox, sourceAssetPath: null, confidence: null,
      structured: { caption: t.caption, numRows: t.numRows, numCols: t.numCols, headerRows: t.headerRows, rows: t.rows.slice(0, 80) },
      metadata: { table_index: t.index },
    });
  }

  for (const f of r.figures) {
    if (f.page == null || !f.caption) continue; // uncaptioned figures carry no citable text yet
    const content = figureToText(f);
    units.push({
      chunkIndex: units.length, contentType: "figure", derivation: "layout_model", content,
      embedText: `${title ? `Paper: ${title}\n` : ""}${content}`, pageStart: f.page, pageEnd: f.page,
      sectionTitle: content.slice(0, 120), sectionKind: "body", tokenEstimate: estimateTokens(content),
      bbox: f.bbox, sourceAssetPath: f.image, confidence: null,
      structured: { caption: f.caption, figure_index: f.index, description: null },
      metadata: { figure_index: f.index },
    });
  }
  return { units, warnings };
}
