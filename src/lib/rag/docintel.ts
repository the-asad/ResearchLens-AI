/**
 * Adapter for the Python document-intelligence worker (Docling) output → the same Block model
 * the chunker uses, plus structured table / figure evidence. Pure and unit-tested.
 */
import type { Block } from "./pdf/types";

export type DocIntelBlock = { label: string; page: number; bbox: number[]; text: string; level?: number };
export type DocIntelTable = {
  index: number; page: number | null; bbox: number[] | null; caption: string | null;
  numRows: number; numCols: number; headerRows: number; rows: string[][];
  cells: { row: number; col: number; rowSpan: number; colSpan: number; text: string; header: boolean }[];
};
export type DocIntelFigure = { index: number; page: number | null; bbox: number[] | null; caption: string | null; image: string | null };
export type DocIntelPage = { page: number; programmaticChars: number; ocr: boolean; ocrConfidence?: number | null };
export type DocIntelResult = {
  pageCount: number; seconds: number; ocr: string; pages?: DocIntelPage[];
  blocks: DocIntelBlock[]; tables: DocIntelTable[]; figures: DocIntelFigure[];
};

/**
 * Deterministic OCR readability score in [0, 1]: share of tokens that look like words
 * (letters, optional trailing punctuation, ≥ 2 chars) weighted with a vowel check. Garbage OCR
 * ("l1|:;~", "rnrn") scores low. Not a language model — a gate against indexing noise.
 */
export function ocrQuality(text: string) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return 0;
  const wordLike = tokens.filter((t) => /^[("'\[]?[A-Za-z][a-z]+[)"'\].,;:!?-]*$/.test(t) && /[aeiouy]/i.test(t)).length;
  return Math.round((wordLike / tokens.length) * 100) / 100;
}

export const OCR_MIN_QUALITY = 0.45;
/** Tesseract mean word confidence below which OCR text is treated as unreliable. */
export const OCR_MIN_CONFIDENCE = 60;

/**
 * Pages whose OCR text is too poor to index (reported, never silently dropped). Primary signal:
 * the OCR engine's own mean word confidence (measured: clean/rotated scans 90–94, degraded 31–34).
 * The text-shape heuristic is only a fallback when no confidence is available — on its own it
 * cannot tell plausible-but-wrong words from correct ones.
 */
export function unreadableOcrPages(r: DocIntelResult) {
  const out: { page: number; confidence: number | null; quality: number }[] = [];
  for (const p of (r.pages ?? []).filter((x) => x.ocr)) {
    const quality = ocrQuality(r.blocks.filter((b) => b.page === p.page).map((b) => b.text).join(" "));
    const unreliable = p.ocrConfidence != null ? p.ocrConfidence < OCR_MIN_CONFIDENCE : quality < OCR_MIN_QUALITY;
    if (unreliable) out.push({ page: p.page, confidence: p.ocrConfidence ?? null, quality });
  }
  return out;
}

const SKIP = new Set(["page_header", "page_footer"]);
const NUMBERED = /^((?:\d{1,2}(?:\.\d{1,2}){0,3})|(?:[A-H](?:\.\d{1,2}){0,3}))\.?\s+\S/;

/** Docling blocks → chunker blocks (headings with numbering depth; captions flagged). */
export function docIntelToBlocks(r: DocIntelResult): Block[] {
  const out: Block[] = [];
  const ocrPages = new Set((r.pages ?? []).filter((p) => p.ocr).map((p) => p.page));
  const unreadable = new Set(unreadableOcrPages(r).map((p) => p.page));
  for (const b of r.blocks) {
    if (SKIP.has(b.label) || unreadable.has(b.page)) continue;
    const text = b.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (b.label === "section_header" || b.label === "title") {
      if (b.label === "title" && b.page === 1) continue; // document title, not a section
      const m = NUMBERED.exec(text);
      out.push({ kind: "heading", text, page: b.page, level: m ? m[1].split(".").length : 1 });
    } else {
      out.push({ kind: "paragraph", text, page: b.page, pageEnd: b.page, caption: b.label === "caption" || undefined, ocr: ocrPages.has(b.page) || undefined });
    }
  }
  return out;
}

/**
 * Structured table → text that keeps row/column semantics for embedding and lexical search:
 *   Table 2: caption
 *   Columns: System | Dev EM | Dev F1 | …
 *   Row 3: System = BERTLARGE | Dev EM = 84.1 | …
 * Header rows are merged per column ("Dev" + "EM" → "Dev EM").
 */
export function tableToText(t: DocIntelTable, maxRows = 60) {
  const h = Math.max(0, Math.min(t.headerRows, t.rows.length - 1));
  const header = Array.from({ length: t.numCols }, (_, c) =>
    [...new Set(t.rows.slice(0, h).map((r) => (r[c] ?? "").trim()).filter(Boolean))].join(" ") || `col${c + 1}`,
  );
  const lines = [t.caption ? t.caption.trim() : `Table ${t.index + 1}`, `Columns: ${header.join(" | ")}`];
  t.rows.slice(h, h + maxRows).forEach((r, i) => {
    const cells = r.map((v, c) => (v?.trim() ? `${header[c]} = ${v.trim()}` : null)).filter(Boolean);
    // Rows whose cells are all identical are spanning group labels ("Top Leaderboard Systems").
    if (new Set(r.map((v) => v.trim())).size === 1 && r[0]?.trim()) lines.push(`Group: ${r[0].trim()}`);
    else if (cells.length) lines.push(`Row ${i + 1}: ${cells.join(" | ")}`);
  });
  if (t.rows.length - h > maxRows) lines.push(`(${t.rows.length - h - maxRows} more rows)`);
  return lines.join("\n");
}

/** Figure → derived text (caption only; vision descriptions are added separately and labelled). */
export function figureToText(f: DocIntelFigure) {
  return f.caption?.trim() || `Figure ${f.index + 1} (no caption)`;
}
