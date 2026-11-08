/** Dev tool: print the extracted structure of a local PDF. Usage: npx tsx scripts/inspect-pdf.mts file.pdf */
import { readFile } from "node:fs/promises";
import { extractPdf } from "../src/lib/rag/pdf/extract";

const file = process.argv[2];
const t0 = performance.now();
const doc = await extractPdf(new Uint8Array(await readFile(file)));
console.log(JSON.stringify({ title: doc.title, pages: doc.pageCount, body: doc.bodyFontSize, warnings: doc.warnings, ms: Math.round(performance.now() - t0) }));
for (const b of doc.blocks) {
  console.log(b.kind === "heading" ? `\n## [p${b.page}] (L${b.level}) ${b.text}` : `[p${b.page}] ${b.text.slice(0, 160)}${b.text.length > 160 ? "…" : ""}`);
}
