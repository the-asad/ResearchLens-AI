import { describe, expect, it } from "vitest";
import { extractPdf, PdfExtractionError } from "@/lib/rag/pdf/extract";
import { headingLevel, isTableLike, normalizeText, orderLines, resolveLineBreakHyphens, SOFT_BREAK, stripMargins } from "@/lib/rag/pdf/layout";
import type { Line } from "@/lib/rag/pdf/types";
import { makePdf } from "./pdf-fixture";

const line = (p: Partial<Line>): Line => ({ page: 1, text: "", x0: 72, x1: 540, y: 700, size: 10, bold: false, column: "full", ...p });

describe("text normalisation", () => {
  it("expands ligatures but keeps scientific symbols", () => {
    expect(normalizeText("eﬃcient ﬁt")).toBe("efficient fit");
    expect(normalizeText("x² ≤ ℝ µm α")).toBe("x² ≤ ℝ µm α");
  });
  it("drops soft hyphens and zero-width chars", () => expect(normalizeText("trans­former​")).toBe("transformer"));
});

describe("line-break hyphens", () => {
  it("joins only when the joined word exists elsewhere in the document", () => {
    const out = resolveLineBreakHyphens([`sequence transduc-${SOFT_BREAK}tion models`, "transduction again", `position-${SOFT_BREAK}wise layers`]);
    expect(out[0]).toBe("sequence transduction models");
    expect(out[2]).toBe("position-wise layers");
  });
});

describe("structure detection", () => {
  it("detects numbered and named headings, rejects table rows and sentences", () => {
    expect(headingLevel(line({ text: "3.2.1 Scaled Dot-Product Attention", bold: true }), 10)).toBe(3);
    expect(headingLevel(line({ text: "References" }), 10)).toBe(1);
    expect(headingLevel(line({ text: "2 Base 512 2048 8 64" }), 10)).toBeNull();
    expect(headingLevel(line({ text: "1 The model is trained for many steps and converges." }), 10)).toBeNull();
  });
  it("flags linearised tables", () => {
    expect(isTableLike("39.2 1.0 · 10^20 39.92 2.3 · 10^19 1.4 · 10^20 40.46")).toBe(true);
    expect(isTableLike("The Transformer achieves 28.4 BLEU on the English-to-German task, improving results.")).toBe(false);
  });
  it("reads two-column pages column by column", () => {
    const lines: Line[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(line({ text: `L${i}`, x0: 72, x1: 290, y: 700 - i * 12 }));
      lines.push(line({ text: `R${i}`, x0: 320, x1: 540, y: 700 - i * 12 }));
    }
    const ordered = orderLines(lines, 612).map((l) => l.text);
    expect(ordered.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `L${i}`));
    expect(ordered.slice(10)).toEqual(Array.from({ length: 10 }, (_, i) => `R${i}`));
  });
  it("removes page numbers and repeated running headers", () => {
    const pages = [1, 2, 3].map((n) => ({
      height: 792,
      lines: [line({ page: n, text: "Conference 2024 — Running Head", y: 770 }), line({ page: n, text: "Body text", y: 400 }), line({ page: n, text: String(n), y: 30 })],
    }));
    expect(stripMargins(pages).map((p) => p.lines.map((l) => l.text))).toEqual([["Body text"], ["Body text"], ["Body text"]]);
  });
});

describe("PDF extraction (real pdf.js on generated PDFs)", () => {
  it("K: rejects an empty / image-only PDF instead of inventing text", async () => {
    const empty = makePdf([{ lines: [] }, { lines: [] }]);
    await expect(extractPdf(empty)).rejects.toMatchObject({ code: "no_text" });
  });
  it("K: rejects corrupt bytes", async () => {
    await expect(extractPdf(new TextEncoder().encode("%PDF-1.4 garbage"))).rejects.toBeInstanceOf(PdfExtractionError);
  });
  it("preserves page numbers and section headings", async () => {
    const para = "Self-attention relates different positions of a single sequence to compute a representation of it.";
    const pdf = makePdf([
      { lines: [{ text: "1 Introduction", x: 72, y: 700, bold: true }, ...Array.from({ length: 4 }, (_, i) => ({ text: para, x: 72, y: 680 - i * 12 }))] },
      { lines: [{ text: "2 Method", x: 72, y: 700, bold: true }, ...Array.from({ length: 4 }, (_, i) => ({ text: para, x: 72, y: 680 - i * 12 }))] },
    ]);
    const doc = await extractPdf(pdf);
    expect(doc.pageCount).toBe(2);
    const headings = doc.blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.page]);
    expect(headings).toEqual([["1 Introduction", 1], ["2 Method", 2]]);
    expect(doc.blocks.find((b) => b.kind === "paragraph" && b.page === 2)?.text).toContain("Self-attention");
  });
});
