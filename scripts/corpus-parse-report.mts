/** Parse every corpus PDF with the production extractor + chunker and report quality stats. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extractPdf } from "../src/lib/rag/pdf/extract";
import { chunkBlocks } from "../src/lib/rag/chunker";
const manifest = JSON.parse(await readFile("eval/corpus/manifest.json", "utf8")) as { papers: { key: string; title: string }[] };
const rows = [];
await mkdir("eval/cache/extract", { recursive: true });
for (const p of manifest.papers) {
  const t0 = performance.now();
  const doc = await extractPdf(new Uint8Array(await readFile(`eval/papers/${p.key}.pdf`)));
  const ms = Math.round(performance.now() - t0);
  const chunks = chunkBlocks(doc.blocks);
  const headings = doc.blocks.filter((b) => b.kind === "heading").length;
  const layouts = chunks.reduce<Record<string, number>>((m, c) => ((m[c.layout] = (m[c.layout] ?? 0) + 1), m), {});
  const tokens = chunks.map((c) => c.tokenEstimate).sort((a, b) => a - b);
  await writeFile(`eval/cache/extract/${p.key}.json`, JSON.stringify(doc));
  rows.push({ key: p.key, pages: doc.pageCount, ms, titleOk: doc.title ? doc.title.slice(0, 40) : "—", headings, chunks: chunks.length, medTok: tokens[Math.floor(tokens.length / 2)], ...layouts, emptyPages: doc.pages.filter((x) => x.empty).length, warnings: doc.warnings.length });
}
console.table(rows);
