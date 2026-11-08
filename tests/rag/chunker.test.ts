import { describe, expect, it } from "vitest";
import { chunkBlocks, embeddingText, estimateTokens, splitSentences, type ChunkConfig } from "@/lib/rag/chunker";
import type { Block } from "@/lib/rag/pdf/types";

const cfg: ChunkConfig = { targetTokens: 100, maxTokens: 160, overlapTokens: 20, minTokens: 30 };
const sentence = (i: number) => `Sentence number ${i} explains one detail of the method in plain words.`;
const para = (n: number, from = 0) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(" ");
const H = (text: string, page = 1, level = 1): Block => ({ kind: "heading", text, page, level });
const P = (text: string, page = 1, pageEnd = page): Block => ({ kind: "paragraph", text, page, pageEnd });

describe("splitSentences", () => {
  it("respects abbreviations, initials and decimals", () => {
    expect(splitSentences("We use e.g. Adam with β = 0.9. Results in Fig. 2 improve. See Vaswani et al. for details.")).toEqual([
      "We use e.g. Adam with β = 0.9.",
      "Results in Fig. 2 improve.",
      "See Vaswani et al. for details.",
    ]);
  });
});

describe("chunkBlocks", () => {
  it("never crosses a section boundary", () => {
    const chunks = chunkBlocks([H("1 Intro"), P(para(3)), H("2 Method"), P(para(3, 10))], cfg);
    for (const c of chunks) expect(c.content.includes("number 1 ") && c.content.includes("number 10 ")).toBe(false);
    expect(new Set(chunks.map((c) => c.sectionTitle))).toEqual(new Set(["1 Intro", "2 Method"]));
  });

  it("respects the max size and splits oversized paragraphs at sentence boundaries with overlap", () => {
    const chunks = chunkBlocks([H("1 Intro"), P(para(40))], cfg);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(cfg.maxTokens + cfg.overlapTokens);
      expect(c.content.trim()).toMatch(/\.$/); // ends on a sentence boundary
    }
    expect(chunks.slice(1).every((c) => c.overlapTokens > 0)).toBe(true);
  });

  it("adds no overlap between whole paragraphs (no duplicated content)", () => {
    const chunks = chunkBlocks([H("1 Intro"), ...Array.from({ length: 6 }, (_, i) => P(para(5, i * 10)))], cfg);
    expect(chunks.every((c) => c.overlapTokens === 0)).toBe(true);
    const all = chunks.map((c) => c.content).join(" ");
    for (let i = 0; i < 6; i++) expect(all.split(sentence(i * 10)).length - 1).toBe(1);
  });

  it("tracks page ranges across page breaks", () => {
    const chunks = chunkBlocks([H("1 Intro", 1), P(para(4), 1, 2)], cfg);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it("folds a tiny parent-section intro into its first subsection", () => {
    const chunks = chunkBlocks([H("5 Training", 7, 1), P("This section describes the training regime.", 7), H("5.1 Data", 7, 2), P(para(5), 7)], cfg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toEqual(["5 Training", "5.1 Data"]);
    expect(chunks[0].mergedParentIntro).toBe("5 Training");
  });

  it("keeps captions and table text out of prose chunks and labels references", () => {
    const chunks = chunkBlocks(
      [H("3 Results"), P(para(3)), { kind: "paragraph", text: "Table 2: BLEU scores.", page: 1, caption: true }, H("References"), P("[1] A. Author. A paper. 2017.")],
      cfg,
    );
    expect(chunks.find((c) => c.layout === "caption")?.content).toBe("Table 2: BLEU scores.");
    expect(chunks.find((c) => c.content.startsWith("[1]"))?.sectionKind).toBe("references");
  });

  it("drops nothing meaningful and produces deterministic indexes", () => {
    const blocks = [H("1 Intro"), P(para(12)), H("2 Method"), P(para(12, 50))];
    const a = chunkBlocks(blocks, cfg);
    const b = chunkBlocks(blocks, cfg);
    expect(a).toEqual(b);
    expect(a.map((c) => c.chunkIndex)).toEqual(a.map((_, i) => i));
    const text = a.map((c) => c.content).join(" ");
    for (const i of [0, 11, 50, 61]) expect(text).toContain(sentence(i));
  });

  it("builds a contextual header for embeddings", () => {
    expect(embeddingText("Paper T", { sectionPath: ["3 Model", "3.1 Encoder"], content: "Body" })).toBe("Paper: Paper T\nSection: 3 Model > 3.1 Encoder\n\nBody");
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});
