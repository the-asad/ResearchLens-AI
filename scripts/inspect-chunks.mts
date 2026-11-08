/** Dev tool: chunk a local PDF and print chunk stats. Usage: npx tsx scripts/inspect-chunks.mts file.pdf */
import { readFile } from "node:fs/promises";
import { extractPdf } from "../src/lib/rag/pdf/extract";
import { chunkBlocks } from "../src/lib/rag/chunker";

const doc = await extractPdf(new Uint8Array(await readFile(process.argv[2])));
const chunks = chunkBlocks(doc.blocks);
const sizes = chunks.map((c) => c.tokenEstimate).sort((a, b) => a - b);
console.log(JSON.stringify({ chunks: chunks.length, min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], max: sizes[sizes.length - 1] }));
for (const c of chunks) {
  console.log(`#${c.chunkIndex} p${c.pageStart}-${c.pageEnd} [${c.sectionKind}/${c.layout}] ${c.tokenEstimate}t ov=${c.overlapTokens} § ${c.sectionPath.join(" > ") || "-"} :: ${c.content.slice(0, 90).replace(/\n/g, " ⏎ ")}`);
}
