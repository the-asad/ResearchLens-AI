/**
 * Parser comparison that does not depend on retrieval: for each paper, how many label evidence
 * phrases survive contiguously, how much text each parser recovers, and structure counts.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { docIntelToBlocks, type DocIntelResult } from "../../src/lib/rag/docintel";
import type { Block } from "../../src/lib/rag/pdf/types";
const manifest = JSON.parse(await readFile("eval/corpus/manifest.json", "utf8")) as { papers: { key: string }[] };
const ds = JSON.parse(await readFile("eval/datasets/multi-paper-v1.json", "utf8")) as { questions: { groups?: { paper: string; evidence: string[] }[] }[] };
const norm = (s: string) => s.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ");
// Long phrases from the papers' own sentences (≥ 5 words) as a contiguity probe: a fused or
// interleaved line breaks them; a correct reading order keeps them intact.
const rows = [];
for (const { key } of manifest.papers) {
  const pdfjs = (JSON.parse(await readFile(`eval/cache/extract/${key}.json`, "utf8")) as { blocks: Block[] }).blocks;
  const dlPath = `eval/cache/docling/${key}.json`;
  if (!existsSync(dlPath)) continue;
  const dl = JSON.parse(await readFile(dlPath, "utf8")) as DocIntelResult;
  const dlBlocks = docIntelToBlocks(dl);
  const pText = norm(pdfjs.map((b) => b.text).join(" "));
  const dText = norm(dlBlocks.map((b) => b.text).join(" ") + " " + dl.tables.flatMap((t) => t.rows.flat()).join(" "));
  // Sample: every 7th sentence of ≥ 12 words from the Docling body text, probe a 6-word window.
  const sents = dlBlocks.filter((b) => b.kind === "paragraph").flatMap((b) => b.text.split(/(?<=[.!?])\s+/)).filter((s) => s.split(" ").length >= 12);
  const probes = sents.filter((_, i) => i % 7 === 0).map((s) => norm(s.split(" ").slice(2, 8).join(" ")));
  const pdfjsKeeps = probes.filter((p) => pText.includes(p)).length;
  const labels = ds.questions.flatMap((q) => q.groups ?? []).filter((g) => g.paper === key).flatMap((g) => g.evidence);
  rows.push({
    paper: key,
    probes: probes.length,
    "pdfjs keeps Docling sentence windows": `${Math.round((100 * pdfjsKeeps) / Math.max(1, probes.length))}%`,
    "label phrases pdfjs": `${labels.filter((e) => pText.includes(norm(e))).length}/${labels.length}`,
    "label phrases docling": `${labels.filter((e) => dText.includes(norm(e))).length}/${labels.length}`,
    "docling sec": dl.seconds,
    tables: dl.tables.length,
    figures: dl.figures.length,
    headings_pdfjs: pdfjs.filter((b) => b.kind === "heading").length,
    headings_docling: dlBlocks.filter((b) => b.kind === "heading").length,
  });
}
console.table(rows);
await mkdir("eval/results/lab", { recursive: true });
await writeFile("eval/results/lab/parser-compare.json", JSON.stringify(rows, null, 2));
