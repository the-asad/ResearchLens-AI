/** Chunking strategies for the ablation. All operate on the production extractor's blocks. */
import { chunkBlocks, estimateTokens, splitSentences, type ChunkConfig } from "../../src/lib/rag/chunker";
import type { Block } from "../../src/lib/rag/pdf/types";
import { docIntelToBlocks, tableToText, type DocIntelResult } from "../../src/lib/rag/docintel";
import { readFileSync, existsSync } from "node:fs";

/** Docling output for a paper, if extracted (eval/cache/docling/<paper>.json). */
export function docling(paper: string): DocIntelResult | null {
  const f = `eval/cache/docling/${paper}.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as DocIntelResult) : null;
}

export type LabChunk = {
  key: string; // paper#index
  paper: string;
  index: number;
  pageStart: number;
  pageEnd: number;
  section: string | null;
  sectionPath: string[];
  content: string;
  /** parent-child: the parent unit this child maps to (retrieval returns parents). */
  parentKey?: string;
};

export type Strategy = { id: string; describe: string; build(paper: string, blocks: Block[]): LabChunk[] };

const section = (id: string, cfg: ChunkConfig, describe: string): Strategy => ({
  id,
  describe,
  build: (paper, blocks) =>
    chunkBlocks(blocks, cfg).map((c) => ({
      key: `${paper}#${c.chunkIndex}`, paper, index: c.chunkIndex, pageStart: c.pageStart, pageEnd: c.pageEnd,
      section: c.sectionPath.at(-1) ?? null, sectionPath: c.sectionPath, content: c.content,
    })),
});

/** Paragraph stream with page tags, ignoring headings (for structure-blind baselines). */
function units(blocks: Block[]) {
  return blocks.filter((b) => b.kind === "paragraph").map((b) => ({ text: b.text, page: b.page, pageEnd: b.pageEnd ?? b.page }));
}

/** Naive fixed windows of ~N tokens over the concatenated text (word-level), with overlap. */
const fixed = (id: string, size: number, overlap: number): Strategy => ({
  id,
  describe: `fixed ${size}-token windows, ${overlap} overlap, structure-blind`,
  build(paper, blocks) {
    const words: { w: string; page: number }[] = [];
    for (const u of units(blocks)) for (const w of u.text.split(/\s+/)) if (w) words.push({ w, page: u.page });
    const per = Math.round(size * 0.75); // ~0.75 words per token
    const step = per - Math.round(overlap * 0.75);
    const out: LabChunk[] = [];
    for (let i = 0; i < words.length; i += step) {
      const slice = words.slice(i, i + per);
      out.push({ key: `${paper}#${out.length}`, paper, index: out.length, pageStart: slice[0].page, pageEnd: slice.at(-1)!.page, section: null, sectionPath: [], content: slice.map((x) => x.w).join(" ") });
      if (i + per >= words.length) break;
    }
    return out;
  },
});

/** Recursive splitter (paragraph → sentence → words) packed to a target, structure-blind. */
const recursive = (id: string, target: number, overlapSentences: number): Strategy => ({
  id,
  describe: `recursive paragraph/sentence packing to ~${target} tokens, ${overlapSentences}-sentence overlap, no section boundaries`,
  build(paper, blocks) {
    const sents: { s: string; page: number }[] = [];
    for (const u of units(blocks)) for (const s of splitSentences(u.text)) sents.push({ s, page: u.page });
    const out: LabChunk[] = [];
    let buf: typeof sents = [];
    const flush = () => {
      if (!buf.length) return;
      out.push({ key: `${paper}#${out.length}`, paper, index: out.length, pageStart: buf[0].page, pageEnd: buf.at(-1)!.page, section: null, sectionPath: [], content: buf.map((x) => x.s).join(" ") });
      buf = overlapSentences ? buf.slice(-overlapSentences) : [];
    };
    for (const s of sents) {
      if (buf.length && estimateTokens(buf.map((x) => x.s).join(" ") + s.s) > target) flush();
      buf.push(s);
    }
    if (buf.length > overlapSentences) flush();
    return out;
  },
});

/**
 * Parent-child: production section chunks are the PARENTS (generation context); each parent is
 * split into ~120-token sentence windows (CHILDREN) for precise matching. Retrieval scores
 * children, then returns parents ranked by their best child.
 */
const parentChild: Strategy = {
  id: "parent_child",
  describe: "children ~120-token sentence windows inside section_v1 parents; rank parents by best child",
  build(paper, blocks) {
    const parents = section("x", { targetTokens: 350, maxTokens: 600, overlapTokens: 60, minTokens: 80 }, "").build(paper, blocks);
    const out: LabChunk[] = [];
    for (const p of parents) {
      let buf: string[] = [];
      const flush = () => {
        if (!buf.length) return;
        out.push({ ...p, key: `${paper}#${out.length}`, index: out.length, content: buf.join(" "), parentKey: p.key });
        buf = [];
      };
      for (const s of splitSentences(p.content.replace(/\n\n/g, " "))) {
        if (buf.length && estimateTokens(buf.join(" ") + s) > 120) flush();
        buf.push(s);
      }
      flush();
    }
    return out;
  },
};

/** Same chunker, but blocks come from Docling (layout model reading order); tables excluded. */
const doclingSection: Strategy = {
  id: "docling_section_v1",
  describe: "Docling reading order → production section chunker (350/600/60); tables not indexed",
  build(paper) {
    const d = docling(paper);
    if (!d) throw new Error(`no docling extraction for ${paper}`);
    return section("x", { targetTokens: 350, maxTokens: 600, overlapTokens: 60, minTokens: 80 }, "").build(paper, docIntelToBlocks(d));
  },
};

/** Docling text chunks + one structured unit per table (caption, columns, rows). */
const doclingTables: Strategy = {
  id: "docling_section_tables",
  describe: "docling_section_v1 + structured table units (caption/columns/rows as text)",
  build(paper) {
    const base = doclingSection.build(paper, []);
    const d = docling(paper)!;
    const tables = d.tables.filter((t) => t.page != null && t.rows.length > 1).map((t, i) => ({
      key: `${paper}#t${i}`, paper, index: base.length + i, pageStart: t.page!, pageEnd: t.page!,
      section: t.caption?.slice(0, 80) ?? `Table ${i + 1}`, sectionPath: [], content: tableToText(t),
    }));
    return [...base, ...tables];
  },
};

export const STRATEGIES: Strategy[] = [
  section("section_v1", { targetTokens: 350, maxTokens: 600, overlapTokens: 60, minTokens: 80 }, "production: section→paragraph→sentence, 350/600/60"),
  section("section_large", { targetTokens: 700, maxTokens: 1000, overlapTokens: 100, minTokens: 150 }, "section-aware, larger: 700/1000/100"),
  fixed("fixed_300", 300, 50),
  recursive("recursive_400", 400, 1),
  parentChild,
  doclingSection,
  doclingTables,
];

/** Parents for the parent_child strategy (needed to judge relevance on returned units). */
export function parentsOf(paper: string, blocks: Block[]) {
  return STRATEGIES[0].build(paper, blocks);
}
