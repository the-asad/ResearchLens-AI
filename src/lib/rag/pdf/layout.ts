/**
 * Layout reconstruction from positioned PDF text runs (pure functions, unit-tested).
 *
 * The PDF text layer has no notion of words, lines, columns or paragraphs — only glyph runs
 * with coordinates. This module rebuilds reading order conservatively:
 *   runs → baselines → column segments → reading order → paragraphs / headings.
 * It never invents text: every output character comes from an input run (plus inserted
 * spaces / newlines and `_` / `^` markers for sub/superscripts).
 */
import type { Block, Line, RawPage } from "./types";

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

/**
 * Conservative normalisation: expand ligatures, unify exotic spaces, drop soft hyphens and
 * zero-width characters. Deliberately NOT NFKC — that would rewrite ², ℝ, µ, ≤ etc.
 */
export function normalizeText(s: string) {
  return s
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[  -   　]/g, " ")
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[ \t]+/g, " ");
}

export function median(values: number[]) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Most common font size weighted by characters — the body text size. */
export function bodyFontSize(pages: RawPage[]) {
  const weight = new Map<number, number>();
  for (const p of pages)
    for (const it of p.items) {
      if (it.rotated || !it.str.trim()) continue;
      const k = Math.round(it.size * 2) / 2;
      weight.set(k, (weight.get(k) ?? 0) + it.str.length);
    }
  let best = 10;
  let bestW = -1;
  for (const [k, w] of weight) if (w > bestW) [best, bestW] = [k, w];
  return best;
}

/**
 * Group runs into baseline clusters, then split each cluster into horizontal segments at
 * large gaps (column gutters). Sub/superscripts (smaller runs offset from the baseline) are
 * attached to their line and marked with `_` / `^`.
 */
export function buildLines(page: RawPage, bodySize: number): Line[] {
  const items = page.items
    .filter((it) => !it.rotated && it.str.length > 0)
    .map((it) => ({ ...it, str: normalizeText(it.str) }))
    .filter((it) => it.str.length > 0);

  // Cluster by baseline. Tolerance scales with font size so sub/superscripts join their line.
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters: (typeof items)[] = [];
  for (const it of sorted) {
    const tol = Math.max(it.size, bodySize) * 0.45;
    const target = clusters.find((c) => Math.abs(anchorY(c, bodySize) - it.y) <= tol && overlapsAny(c, it));
    if (target) target.push(it);
    else clusters.push([it]);
  }

  const lines: Line[] = [];
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x - b.x);
    const base = anchorY(cluster, bodySize);
    const lineSize = Math.max(...cluster.filter((c) => c.str.trim()).map((c) => c.size), 0) || bodySize;
    const gutter = Math.max(lineSize * 1.8, 14);

    let seg: typeof cluster = [];
    const flush = () => {
      const visible = seg.filter((s) => s.str.trim());
      if (visible.length === 0) return (seg = []);
      lines.push({
        page: page.pageNumber,
        text: joinRuns(seg, base, lineSize),
        x0: visible[0].x,
        x1: Math.max(...visible.map((s) => s.x + s.width)),
        y: base,
        size: lineSize,
        bold: visible.filter((s) => s.bold).reduce((n, s) => n + s.str.length, 0) >
          visible.reduce((n, s) => n + s.str.length, 0) / 2,
        column: "full",
      });
      seg = [];
    };
    for (const it of cluster) {
      const prev = [...seg].reverse().find((s) => s.str.trim());
      if (prev && it.str.trim() && it.x - (prev.x + prev.width) > gutter) flush();
      seg.push(it);
    }
    flush();
  }
  return lines;
}

function anchorY(cluster: { y: number; size: number }[], bodySize: number) {
  // Baseline of the largest (non-script) run in the cluster.
  const main = cluster.filter((c) => c.size >= bodySize * 0.85);
  const pool = main.length ? main : cluster;
  return pool.reduce((m, c) => (c.size > m.size ? c : m), pool[0]).y;
}

function overlapsAny(cluster: { x: number; width: number }[], it: { x: number; width: number }) {
  // Prevents a superscript at one x from joining an unrelated line far away horizontally is
  // unnecessary at this granularity; clusters are split by gutters afterwards.
  return cluster.length > 0 && it.width >= 0;
}

function joinRuns(runs: { str: string; x: number; width: number; y: number; size: number }[], base: number, lineSize: number) {
  let out = "";
  let prevEnd: number | null = null;
  let prevScript: "_" | "^" | null = null;
  for (const r of runs) {
    let s = r.str;
    if (!s.trim()) {
      if (out && !out.endsWith(" ")) out += " ";
      prevEnd = r.x + r.width;
      prevScript = null;
      continue;
    }
    const small = r.size < lineSize * 0.82;
    const dy = r.y - base;
    const attached = prevEnd !== null && r.x - prevEnd < lineSize * 0.25;
    const script = small && Math.abs(dy) > lineSize * 0.12 ? (dy < 0 ? "_" : "^") : null;
    if (script && attached && /\S$/.test(out)) {
      // One marker per contiguous script run: 10^−9, not 10^−^9.
      s = (prevScript === script ? "" : script) + s.trim();
      out += s;
      prevEnd = r.x + r.width;
      prevScript = script;
      continue;
    }
    prevScript = null;
    if (prevEnd !== null && r.x - prevEnd > lineSize * 0.15 && out && !out.endsWith(" ") && !s.startsWith(" ")) {
      out += " ";
    }
    out += s;
    prevEnd = r.x + r.width;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

/**
 * Decide column membership and return lines in reading order. A page is treated as two-column
 * only when both halves carry substantial text; full-width lines (titles, wide figures'
 * captions) keep their vertical position, and each column region is read left then right.
 */
export function orderLines(lines: Line[], pageWidth: number): Line[] {
  const mid = pageWidth / 2;
  const slack = pageWidth * 0.03;
  for (const l of lines) {
    if (l.x1 <= mid + slack) l.column = "left";
    else if (l.x0 >= mid - slack) l.column = "right";
    else l.column = "full";
  }
  const left = lines.filter((l) => l.column === "left").length;
  const right = lines.filter((l) => l.column === "right").length;
  const twoColumn = left >= 8 && right >= 8 && right >= lines.length * 0.2;

  const byY = [...lines].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  if (!twoColumn) {
    for (const l of byY) l.column = "full";
    return byY;
  }
  const out: Line[] = [];
  let region: Line[] = [];
  const flushRegion = () => {
    out.push(...region.filter((l) => l.column === "left"), ...region.filter((l) => l.column === "right"));
    region = [];
  };
  for (const l of byY) {
    if (l.column === "full") {
      flushRegion();
      out.push(l);
    } else region.push(l);
  }
  flushRegion();
  return out;
}

/** Normalised signature for detecting running headers/footers across pages. */
export function marginSignature(text: string) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * Remove page numbers and running headers/footers: short lines in the top/bottom 7% of the page
 * that are pure numbers or repeat (digit-normalised) on at least 3 pages.
 */
export function stripMargins(pages: { lines: Line[]; height: number }[]) {
  const isMargin = (l: Line, h: number) => (l.y < h * 0.07 || l.y > h * 0.93) && l.text.length <= 80;
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.lines) if (isMargin(l, p.height)) seen.add(marginSignature(l.text));
    for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const repeated = (s: string) => (counts.get(s) ?? 0) >= Math.min(3, Math.max(2, pages.length));
  return pages.map((p) => {
    const kept = p.lines.filter(
      (l) => !(isMargin(l, p.height) && (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text.trim()) || repeated(marginSignature(l.text)))),
    );
    return { lines: kept, dropped: p.lines.length - kept.length };
  });
}

const NAMED_HEADING =
  /^(abstract|introduction|related work|background|preliminaries|method(s|ology)?|approach|experiments?|experimental (setup|results)|evaluation|results|discussion|analysis|conclusions?( and future work)?|future work|limitations|acknowledg(e)?ments?|references|bibliography|appendix(\s+[A-Z])?|supplementary material)$/i;
const NUMBERED_HEADING = /^((?:\d{1,2}(?:\.\d{1,2}){0,3})|(?:[A-H](?:\.\d{1,2}){0,3}))\.?\s+([A-Z][^\n]{0,100})$/;

/** Classify a line as a heading. Returns numbering depth, or null for body text. */
export function headingLevel(line: Line, bodySize: number): number | null {
  const text = line.text.trim();
  if (text.length < 3 || text.length > 110) return null;
  const words = text.split(/\s+/).length;
  if (NAMED_HEADING.test(text.replace(/[.:]$/, ""))) return 1;
  const m = NUMBERED_HEADING.exec(text);
  if (m) {
    const rest = m[2];
    const plausible =
      words <= 14 &&
      !/[.,;:]$/.test(rest) &&
      !/\d\s+\d/.test(rest) && // table rows such as "2 Base 512 2048"
      (line.bold || line.size >= bodySize * 1.1 || words <= 8);
    if (plausible) return m[1].split(".").length;
  }
  // Unnumbered heading set in a larger font (not the page-1 title — handled separately).
  if (line.size >= bodySize * 1.25 && words <= 12 && !/[.,;]$/.test(text)) return 1;
  return null;
}

/**
 * Turn ordered lines into heading / paragraph blocks. Paragraph breaks come from vertical gaps
 * larger than the typical line spacing, column switches, or a short line ending a sentence.
 * Hyphenated line breaks keep their hyphen ("position-" + "wise" → "position-wise").
 */
export function buildBlocks(lines: Line[], bodySize: number, skip?: (l: Line) => boolean): Block[] {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (lines[i].page === lines[i - 1].page && lines[i].column === lines[i - 1].column && g > 0 && g < bodySize * 3) gaps.push(g);
  }
  const spacing = median(gaps) || bodySize * 1.2;
  const widths = lines.map((l) => l.x1 - l.x0);
  const fullWidth = Math.max(...widths, 1);

  const blocks: Block[] = [];
  let current: { lines: Line[] } | null = null;
  const flush = () => {
    if (current && current.lines.length) {
      blocks.push({
        kind: "paragraph",
        text: joinLines(current.lines),
        page: current.lines[0].page,
        pageEnd: current.lines[current.lines.length - 1].page,
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skip?.(line)) continue;
    const level = headingLevel(line, bodySize);
    if (level !== null) {
      flush();
      const bySize = !NAMED_HEADING.test(line.text.trim().replace(/[.:]$/, "")) && !NUMBERED_HEADING.test(line.text.trim());
      blocks.push({ kind: "heading", text: line.text.trim(), page: line.page, level, bySize: bySize || undefined });
      continue;
    }
    if (CAPTION.test(line.text.trim())) flush();
    const prev: Line | undefined = current?.lines[current.lines.length - 1];
    if (prev && CAPTION.test(joinLines(current!.lines)) && /[.]$/.test(prev.text)) flush();
    if (current && current.lines.length) {
      const p = current.lines[current.lines.length - 1];
      const gap = p.y - line.y;
      const newColumnOrPage = p.page !== line.page || p.column !== line.column || gap < 0;
      const bigGap = gap > spacing * 1.45;
      const prevShortSentenceEnd = p.x1 - p.x0 < fullWidth * 0.7 && /[.!?:]["')\]]?$/.test(p.text);
      const indented = line.x0 > p.x0 + bodySize * 0.8 && !newColumnOrPage;
      if (isNumericLine(p.text) !== isNumericLine(line.text)) flush(); // table rows ↔ prose
      else if (bigGap && !newColumnOrPage) flush();
      else if (!newColumnOrPage && prevShortSentenceEnd && (indented || bigGap)) flush();
      else if (indented && /[.!?]["')\]]?$/.test(p.text)) flush();
      // Page/column continuation: keep the paragraph unless the previous one clearly ended.
      else if (newColumnOrPage && /[.!?]["')\]]?$/.test(p.text) && prevShortSentenceEnd) flush();
    }
    if (!current) current = { lines: [] };
    current.lines.push(line);
  }
  flush();
  return finalizeBlocks(blocks);
}

/** Marks a hyphen that ended a line; resolved later by {@link resolveLineBreakHyphens}. */
export const SOFT_BREAK = "\u0001";

export function joinLines(lines: Line[]) {
  let out = "";
  for (const l of lines) {
    const t = l.text.trim();
    if (!out) out = t;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + "-" + SOFT_BREAK + t;
    else out += " " + t;
  }
  return out.replace(/ {2,}/g, " ");
}

/**
 * Resolve line-break hyphens using the document's own vocabulary: "transduc-␁tion" becomes
 * "transduction" only if "transduction" occurs elsewhere in the paper; otherwise the hyphen is
 * kept ("position-wise"). Never guesses from an external dictionary.
 */
export function resolveLineBreakHyphens(texts: string[]): string[] {
  const vocab = new Set<string>();
  for (const t of texts) for (const w of t.replace(new RegExp(`-${SOFT_BREAK}`, "g"), "-").match(/[A-Za-z]+/g) ?? []) vocab.add(w.toLowerCase());
  const re = new RegExp(`([A-Za-z]+)-${SOFT_BREAK}([a-z]+)`, "g");
  return texts.map((t) =>
    t.replace(re, (_m, a: string, b: string) => (vocab.has((a + b).toLowerCase()) ? a + b : `${a}-${b}`)).replaceAll(SOFT_BREAK, ""),
  );
}

const CAPTION = /^(Table|Figure|Fig\.)\s*[A-Z]?\d+[:.]/;

/** A single line dominated by numbers / very short tokens (a table row, axis labels). */
export function isNumericLine(text: string) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  const numeric = tokens.filter((t) => /^[\d.,·×%±()^_\-–−+]+$/.test(t) || t.length <= 2).length;
  return numeric / tokens.length > 0.5;
}

/** Linearised table / figure text: dominated by numbers and very short tokens. */
export function isTableLike(text: string) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 8) return false;
  const numeric = tokens.filter((t) => /^[\d.,·×%±()^_\-–−+]+$/.test(t) || t.length <= 2).length;
  return numeric / tokens.length > 0.5;
}

/** Post-process blocks: captions, table-like text, repeated size-only headings, hyphens. */
export function finalizeBlocks(blocks: Block[]): Block[] {
  const sizeHeadingCounts = new Map<string, number>();
  // Figure labels drawn in large type repeat across pages; real headings do not.
  const key = (t: string) => t.replace(/[_^].*$/, "").trim();
  for (const b of blocks) if (b.kind === "heading" && b.bySize) sizeHeadingCounts.set(key(b.text), (sizeHeadingCounts.get(key(b.text)) ?? 0) + 1);
  const resolved = resolveLineBreakHyphens(blocks.map((b) => b.text));
  return blocks.map((b, i) => {
    const text = resolved[i].trim();
    if (b.kind === "heading" && b.bySize && (sizeHeadingCounts.get(key(b.text)) ?? 0) > 1) {
      return { kind: "paragraph", text, page: b.page, tableLike: true };
    }
    if (b.kind === "heading") return { ...b, text };
    return { ...b, text, caption: CAPTION.test(text) || undefined, tableLike: isTableLike(text) || undefined };
  });
}

/** Page-1 title: the largest-font text in the top half of the first page. */
export function detectTitle(lines: Line[], pageHeight: number, bodySize: number) {
  const candidates = lines.filter((l) => l.page === 1 && l.y > pageHeight * 0.45 && l.size >= bodySize * 1.2 && l.text.length >= 4);
  if (candidates.length === 0) return null;
  const maxSize = Math.max(...candidates.map((l) => l.size));
  const titleLines = candidates.filter((l) => Math.abs(l.size - maxSize) < 0.5).sort((a, b) => b.y - a.y);
  const title = titleLines.map((l) => l.text.trim()).join(" ").replace(/\s+/g, " ").trim();
  return title.length >= 4 && title.length <= 300 ? title : null;
}
