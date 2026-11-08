import { describe, expect, it } from "vitest";
import { docIntelToBlocks, tableToText, type DocIntelTable } from "@/lib/rag/docintel";

describe("Docling adapter", () => {
  it("maps labels to blocks, drops running headers and the page-1 title, derives heading depth", () => {
    const blocks = docIntelToBlocks({
      pageCount: 1, seconds: 0, ocr: "off", tables: [], figures: [],
      blocks: [
        { label: "title", page: 1, bbox: [], text: "BERT" },
        { label: "page_header", page: 1, bbox: [], text: "Under review" },
        { label: "section_header", page: 1, bbox: [], text: "3.1 Pre-training BERT" },
        { label: "text", page: 1, bbox: [], text: "We mask  15%   of tokens." },
        { label: "caption", page: 1, bbox: [], text: "Table 1: GLUE results." },
      ],
    });
    expect(blocks).toEqual([
      { kind: "heading", text: "3.1 Pre-training BERT", page: 1, level: 2 },
      { kind: "paragraph", text: "We mask 15% of tokens.", page: 1, pageEnd: 1, caption: undefined, ocr: undefined },
      { kind: "paragraph", text: "Table 1: GLUE results.", page: 1, pageEnd: 1, caption: true, ocr: undefined },
    ]);
  });

  it("renders tables with merged multi-row headers, group rows and exact cell values", () => {
    const t: DocIntelTable = {
      index: 1, page: 7, bbox: null, caption: "Table 2: SQuAD 1.1 results.", numRows: 5, numCols: 3, headerRows: 2, cells: [],
      rows: [["System", "Dev", "Dev"], ["", "EM", "F1"], ["Published", "Published", "Published"], ["BERTBASE", "80.8", "88.5"], ["BERTLARGE", "84.1", "90.9"]],
    };
    expect(tableToText(t)).toBe(
      "Table 2: SQuAD 1.1 results.\nColumns: System | Dev EM | Dev F1\nGroup: Published\nRow 2: System = BERTBASE | Dev EM = 80.8 | Dev F1 = 88.5\nRow 3: System = BERTLARGE | Dev EM = 84.1 | Dev F1 = 90.9",
    );
  });
});

describe("OCR provenance and quality gate", () => {
  it("marks OCR-page text, scores readability and excludes unreadable OCR pages", async () => {
    const { ocrQuality, unreadableOcrPages } = await import("@/lib/rag/docintel");
    expect(ocrQuality("The model is trained with masked language modeling on large corpora.")).toBeGreaterThan(0.8);
    expect(ocrQuality("l1| :;~ rnrn ,,. Tl|e 0O0 ~~ |||| ;;")).toBeLessThan(0.3);
    const r = {
      pageCount: 2, seconds: 0, ocr: "auto", tables: [], figures: [],
      pages: [{ page: 1, programmaticChars: 0, ocr: true }, { page: 2, programmaticChars: 0, ocr: true }],
      blocks: [
        { label: "text", page: 1, bbox: [], text: "Self-attention relates positions of a single sequence to compute representations." },
        { label: "text", page: 2, bbox: [], text: "l1| :;~ rnrn ,,. Tl|e 0O0 ~~ |||| ;;" },
      ],
    };
    expect(unreadableOcrPages(r)).toEqual([{ page: 2, confidence: null, quality: expect.any(Number) }]);
    // Engine confidence takes precedence over the text heuristic when present.
    const withConf = { ...r, pages: [{ page: 1, programmaticChars: 0, ocr: true, ocrConfidence: 33 }, { page: 2, programmaticChars: 0, ocr: true, ocrConfidence: 92 }] };
    expect(unreadableOcrPages(withConf).map((p) => p.page)).toEqual([1]);
    const blocks = docIntelToBlocks(r);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ page: 1, ocr: true });
  });
});

describe("multimodal evidence units", () => {
  it("emits prose, ocr_text, table and figure units with provenance", async () => {
    const { buildEvidenceUnits } = await import("@/lib/rag/multimodal");
    const para = "Self-attention relates different positions of a single sequence to compute a representation of it. ".repeat(3);
    const { units, warnings } = buildEvidenceUnits(
      {
        pageCount: 3, seconds: 1, ocr: "auto",
        pages: [{ page: 1, programmaticChars: 900, ocr: false }, { page: 2, programmaticChars: 0, ocr: true, ocrConfidence: 92 }, { page: 3, programmaticChars: 0, ocr: true, ocrConfidence: 31 }],
        blocks: [
          { label: "section_header", page: 1, bbox: [], text: "1 Introduction" },
          { label: "text", page: 1, bbox: [], text: para },
          { label: "section_header", page: 2, bbox: [], text: "2 Method" },
          { label: "text", page: 2, bbox: [], text: para },
          { label: "text", page: 3, bbox: [], text: "garbled ocr text that should never be indexed at all" },
        ],
        tables: [{ index: 0, page: 1, bbox: [1, 2, 3, 4], caption: "Table 1: Scores.", numRows: 2, numCols: 2, headerRows: 1, cells: [], rows: [["Model", "F1"], ["BERT", "93.2"]] }],
        figures: [{ index: 0, page: 2, bbox: [5, 6, 7, 8], caption: "Figure 1: Architecture.", image: "u/p/d/derived/figures/figure-0-p2.png" }, { index: 1, page: 2, bbox: null, caption: null, image: null }],
      },
      "Paper",
      { kind: "paper" },
    );
    expect(warnings[0]).toMatch(/page\(s\) 3/);
    expect(units.map((u) => u.contentType)).toEqual(["text", "ocr_text", "table", "figure"]);
    expect(units[1]).toMatchObject({ derivation: "ocr", confidence: 0.92, pageStart: 2 });
    expect(units[2]).toMatchObject({ derivation: "table_model", bbox: [1, 2, 3, 4], content: expect.stringContaining("Model = BERT | F1 = 93.2") });
    expect(units[3]).toMatchObject({ sourceAssetPath: "u/p/d/derived/figures/figure-0-p2.png", content: "Figure 1: Architecture." });
    expect(units.some((u) => u.content.includes("garbled"))).toBe(false);
  });
});

describe("phase-2 prose policy", () => {
  it("ocr_only keeps Docling prose only for pages without a text layer", async () => {
    const { buildEvidenceUnits } = await import("@/lib/rag/multimodal");
    const para = "Self-attention relates different positions of a single sequence to compute a representation of it. ".repeat(3);
    const r = {
      pageCount: 2, seconds: 1, ocr: "auto", tables: [], figures: [],
      pages: [{ page: 1, programmaticChars: 900, ocr: false }, { page: 2, programmaticChars: 0, ocr: true, ocrConfidence: 92 }],
      blocks: [{ label: "text", page: 1, bbox: [], text: para }, { label: "text", page: 2, bbox: [], text: para }],
    };
    const { units } = buildEvidenceUnits(r, "P", { kind: "paper", prose: "ocr_only" });
    expect(units.map((u) => [u.contentType, u.pageStart])).toEqual([["ocr_text", 2]]);
  });
});
