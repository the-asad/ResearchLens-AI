/**
 * Research-paper-aware chunker (pure, unit-tested).
 *
 * Boundaries in priority order: section → paragraph → sentence. Chunks never cross a section
 * heading. Whole paragraphs are packed up to the target size (allowed to grow to the max so a
 * paragraph is not cut); only paragraphs larger than the max are split, at sentence boundaries,
 * and only those splits get overlap. Captions and linearised table text are kept apart from prose.
 */
import { CHUNKING } from "./config";
import type { Block, SectionKind } from "./pdf/types";

export type ChunkConfig = {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  minTokens: number;
};

export const defaultChunkConfig: ChunkConfig = {
  targetTokens: CHUNKING.CHUNK_TARGET_TOKENS,
  maxTokens: CHUNKING.CHUNK_MAX_TOKENS,
  overlapTokens: CHUNKING.CHUNK_OVERLAP_TOKENS,
  minTokens: CHUNKING.CHUNK_MIN_TOKENS,
};

export type Chunk = {
  chunkIndex: number;
  content: string;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  sectionPath: string[];
  sectionKind: SectionKind;
  tokenEstimate: number;
  layout: "prose" | "caption" | "table_like";
  overlapTokens: number;
  /** Set when a parent section's short intro was folded into this chunk. */
  mergedParentIntro?: string;
  /** Any part of this chunk came from OCR (page without a digital text layer). */
  ocr?: boolean;
};

/** ~4 characters per token for English scientific prose (an estimate, not a tokenizer). */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

const ABBREVIATIONS =
  /(?:\b(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Sec|Secs|Tab|No|approx|resp|Dr|Mr|Ms|Prof|Inc|Ltd|al|ca|viz)\.|\b[A-Z]\.)$/;

/** Sentence splitter that respects abbreviations, initials, decimals and citations. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]["')\]]*\s+(?=[A-Z0-9(\["“])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const candidate = text.slice(start, m.index + 1);
    if (ABBREVIATIONS.test(candidate.trimEnd())) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

type Unit = { text: string; pageStart: number; pageEnd: number; layout: Chunk["layout"]; ocr?: boolean };
type Piece = Unit & { tokens: number; paragraphId: number; continues: boolean };

type Section = { title: string | null; path: string[]; kind: SectionKind; units: Unit[] };

const REFERENCE_ENTRY = /^(\[\d{1,3}\]|\d{1,3}\.\s+[A-Z]|[A-Z][A-Za-z'’-]+,\s+[A-Z])/;

/** Group blocks into sections with a heading path and a coarse kind. */
export function buildSections(blocks: Block[]): Section[] {
  const sections: Section[] = [];
  let path: { level: number; text: string }[] = [];
  let kind: SectionKind = "front_matter";
  let seenReferences = false;
  let current: Section = { title: null, path: [], kind, units: [] };
  sections.push(current);

  for (const b of blocks) {
    if (b.kind === "heading") {
      const t = b.text.replace(/[.:]$/, "").trim();
      const level = b.level ?? 1;
      if (/^abstract$/i.test(t)) kind = "abstract";
      else if (/^(references|bibliography)$/i.test(t)) {
        kind = "references";
        seenReferences = true;
      } else if (/^appendix/i.test(t) || /^[A-H](\.\d+)*\s/.test(t) || seenReferences) kind = "appendix";
      else kind = "body";
      path = [...path.filter((p) => p.level < level), { level, text: t }];
      current = { title: t, path: path.map((p) => p.text), kind, units: [] };
      sections.push(current);
      continue;
    }
    // Inside "References", captions/figure text belong to appendix material, not citations.
    if (current.kind === "references" && !REFERENCE_ENTRY.test(b.text) && b.caption) {
      current = { title: current.title, path: current.path, kind: "appendix", units: [] };
      sections.push(current);
    }
    const layout: Chunk["layout"] = b.caption ? "caption" : b.tableLike ? "table_like" : "prose";
    current.units.push({ text: b.text, pageStart: b.page, pageEnd: b.pageEnd ?? b.page, layout, ocr: b.ocr });
  }
  return sections.filter((s) => s.units.length > 0);
}

function toPieces(units: Unit[], cfg: ChunkConfig): Piece[] {
  const pieces: Piece[] = [];
  units.forEach((u, paragraphId) => {
    const tokens = estimateTokens(u.text);
    if (tokens <= cfg.maxTokens) {
      pieces.push({ ...u, tokens, paragraphId, continues: false });
      return;
    }
    // Oversized paragraph: pack sentences into pieces of about the target size.
    const sentences = splitSentences(u.text).flatMap((s) => hardSplit(s, cfg.maxTokens));
    let buf: string[] = [];
    let bufTokens = 0;
    const emit = (last: boolean) => {
      if (!buf.length) return;
      const text = buf.join(" ");
      pieces.push({ ...u, text, tokens: estimateTokens(text), paragraphId, continues: !last });
      buf = [];
      bufTokens = 0;
    };
    sentences.forEach((s, i) => {
      const t = estimateTokens(s);
      if (bufTokens > 0 && bufTokens + t > cfg.targetTokens) emit(false);
      buf.push(s);
      bufTokens += t;
      if (i === sentences.length - 1) emit(true);
    });
  });
  return pieces;
}

/** Last resort for a single "sentence" longer than the max (e.g. a linearised table). */
function hardSplit(sentence: string, maxTokens: number): string[] {
  if (estimateTokens(sentence) <= maxTokens) return [sentence];
  const words = sentence.split(/\s+/);
  const out: string[] = [];
  let buf: string[] = [];
  for (const w of words) {
    buf.push(w);
    if (estimateTokens(buf.join(" ")) >= maxTokens * 0.9) {
      out.push(buf.join(" "));
      buf = [];
    }
  }
  if (buf.length) out.push(buf.join(" "));
  return out;
}

function tailSentences(text: string, budget: number) {
  const sentences = splitSentences(text);
  const tail: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = estimateTokens(sentences[i]);
    if (tokens + t > budget) break;
    tail.unshift(sentences[i]);
    tokens += t;
  }
  return { text: tail.join(" "), tokens };
}

export function chunkBlocks(blocks: Block[], cfg: ChunkConfig = defaultChunkConfig): Chunk[] {
  const chunks: Omit<Chunk, "chunkIndex">[] = [];

  for (const section of buildSections(blocks)) {
    // Figures and tables float: prose before and after them is one continuous argument, so
    // prose is packed as one stream and captions/table text as another (both in reading order).
    const streams: Unit[][] = [
      section.units.filter((u) => u.layout === "prose"),
      section.units.filter((u) => u.layout !== "prose"),
    ].filter((s) => s.length > 0);

    for (const stream of streams) {
      const sectionChunks: Omit<Chunk, "chunkIndex">[] = [];
      let parts: Piece[] = [];
      let overlap = { text: "", tokens: 0 };
      const close = () => {
        if (!parts.length) return;
        // Pieces of the same paragraph join with a space; paragraphs with a blank line.
        let content = overlap.text;
        let lastPara = -1;
        for (const p of parts) {
          content += content ? (p.paragraphId === lastPara ? " " : "\n\n") : "";
          content += p.text;
          lastPara = p.paragraphId;
        }
        const layout = parts.every((p) => p.layout === "caption")
          ? "caption"
          : parts.some((p) => p.layout === "table_like")
            ? "table_like"
            : parts[0].layout;
        sectionChunks.push({
          content,
          pageStart: Math.min(...parts.map((p) => p.pageStart)),
          pageEnd: Math.max(...parts.map((p) => p.pageEnd)),
          sectionTitle: section.title,
          sectionPath: section.path,
          sectionKind: section.kind,
          tokenEstimate: estimateTokens(content),
          layout,
          overlapTokens: overlap.tokens,
          ...(parts.some((p) => p.ocr) ? { ocr: true } : {}),
        });
        const last = parts[parts.length - 1];
        overlap = last.continues && cfg.overlapTokens > 0 ? tailSentences(last.text, cfg.overlapTokens) : { text: "", tokens: 0 };
        parts = [];
      };

      for (const piece of toPieces(stream, cfg)) {
        const current = parts.reduce((n, p) => n + p.tokens, overlap.tokens);
        if (parts.length && (current + piece.tokens > cfg.maxTokens || current >= cfg.targetTokens)) close();
        parts.push(piece);
      }
      close();

      // Merge a too-small trailing chunk into its predecessor when it fits.
      if (sectionChunks.length >= 2) {
        const last = sectionChunks[sectionChunks.length - 1];
        const prev = sectionChunks[sectionChunks.length - 2];
        if (last.tokenEstimate < cfg.minTokens && prev.tokenEstimate + last.tokenEstimate <= cfg.maxTokens) {
          const tail = last.overlapTokens ? last.content.slice(tailLength(last)) : last.content;
          prev.content += "\n\n" + tail.trim();
          prev.pageEnd = Math.max(prev.pageEnd, last.pageEnd);
          prev.tokenEstimate = estimateTokens(prev.content);
          sectionChunks.pop();
        }
      }
      chunks.push(...sectionChunks.filter((c) => c.content.replace(/\s/g, "").length >= 10));
    }
  }
  return mergeParentIntros(chunks, cfg).map((c, i) => ({ ...c, chunkIndex: i }));
}

/**
 * A tiny chunk that is a parent section's whole introduction ("5 Training: This section
 * describes…") is folded into the first chunk of its child subsection. The child keeps its own
 * section path; the merge is recorded so provenance stays exact.
 */
function mergeParentIntros(chunks: Omit<Chunk, "chunkIndex">[], cfg: ChunkConfig) {
  const out: (Omit<Chunk, "chunkIndex"> & { mergedParentIntro?: string })[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    const isChild =
      next &&
      c.layout === "prose" &&
      next.layout === "prose" &&
      next.sectionPath.length > c.sectionPath.length &&
      c.sectionPath.every((p, k) => next.sectionPath[k] === p);
    if (isChild && c.tokenEstimate < cfg.minTokens && c.tokenEstimate + next.tokenEstimate <= cfg.maxTokens) {
      chunks[i + 1] = {
        ...next,
        content: `${c.content}\n\n${next.content}`,
        pageStart: Math.min(c.pageStart, next.pageStart),
        tokenEstimate: estimateTokens(`${c.content}\n\n${next.content}`),
        mergedParentIntro: c.sectionTitle ?? undefined,
      } as Omit<Chunk, "chunkIndex">;
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Character length of the overlap prefix carried into a chunk (approximate, by tokens). */
function tailLength(c: { overlapTokens: number }) {
  return c.overlapTokens * 4;
}

/** Text sent to the embedding model: a short contextual header + the chunk content. */
export function embeddingText(docTitle: string | null, chunk: Pick<Chunk, "sectionPath" | "content">) {
  const header = [docTitle ? `Paper: ${docTitle}` : null, chunk.sectionPath.length ? `Section: ${chunk.sectionPath.join(" > ")}` : null]
    .filter(Boolean)
    .join("\n");
  return header ? `${header}\n\n${chunk.content}` : chunk.content;
}
