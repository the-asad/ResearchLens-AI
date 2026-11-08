/** OCR evaluation on synthetic scans: production pdf.js path vs Docling+Tesseract, scored against true page text. */
import { readFile } from "node:fs/promises";
import { extractPdf, readPdf } from "../../src/lib/rag/pdf/extract";
import { buildLines, bodyFontSize, orderLines } from "../../src/lib/rag/pdf/layout";
import type { DocIntelResult } from "../../src/lib/rag/docintel";
const truthPdf = await readPdf(new Uint8Array(await readFile("eval/papers/distilbert.pdf")));
const body = bodyFontSize(truthPdf);
const pageText = (i: number) => orderLines(buildLines(truthPdf[i], body), truthPdf[i].width).map((l) => l.text).join(" ");
const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
const score = (truth: string, got: string) => {
  const t = words(truth), g = new Set(words(got));
  const tg = new Set(t);
  const recall = t.filter((w) => g.has(w)).length / Math.max(1, t.length);
  const precision = [...g].filter((w) => tg.has(w)).length / Math.max(1, g.size);
  return { recall: Math.round(recall * 1000) / 10, precision: Math.round(precision * 1000) / 10 };
};
const cases: Record<string, number[]> = { clean: [0, 2, 3], degraded: [0, 2, 3], rotated: [0, 2], mixed: [0, 1, 3] };
for (const [name, truthPages] of Object.entries(cases)) {
  let prod: string;
  try {
    const d = await extractPdf(new Uint8Array(await readFile(`eval/scans/scan-${name}.pdf`)));
    prod = `ok (${d.pageCount} pages, warnings: ${d.warnings.join("; ") || "none"})`;
  } catch (e) {
    prod = `rejected: ${(e as Error).message}`;
  }
  const dl = JSON.parse(await readFile(`eval/cache/docling/scan-${name}.json`, "utf8")) as DocIntelResult;
  const perPage = truthPages.map((tp, i) => {
    const got = dl.blocks.filter((b) => b.page === i + 1).map((b) => b.text).join(" ") + " " + dl.tables.filter((t) => t.page === i + 1).flatMap((t) => t.rows.flat()).join(" ");
    return { page: i + 1, ...score(pageText(tp), got) };
  });
  console.log(JSON.stringify({ scan: name, productionPdfjs: prod, doclingOcr: { seconds: dl.seconds, perPage } }));
}
