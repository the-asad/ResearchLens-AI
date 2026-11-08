/**
 * Download the benchmark corpus listed in eval/corpus/manifest.json from arXiv into
 * eval/papers/<key>.pdf (git-ignored). Idempotent; verifies the %PDF- signature; polite delay.
 * Usage: npx tsx scripts/download-corpus.mts
 */
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
const manifest = JSON.parse(await readFile("eval/corpus/manifest.json", "utf8")) as { papers: { key: string; arxiv: string }[] };
await mkdir("eval/papers", { recursive: true });
for (const p of manifest.papers) {
  const out = `eval/papers/${p.key}.pdf`;
  if (await stat(out).then((s) => s.size > 1000).catch(() => false)) {
    console.log(`skip ${p.key} (exists)`);
    continue;
  }
  const res = await fetch(`https://arxiv.org/pdf/${p.arxiv}`, { headers: { "User-Agent": "ResearchLens-benchmark/1.0" } });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok || new TextDecoder().decode(buf.slice(0, 5)) !== "%PDF-") throw new Error(`bad download for ${p.key}: HTTP ${res.status}`);
  await writeFile(out, buf);
  console.log(`ok ${p.key} ${(buf.length / 1e6).toFixed(2)} MB`);
  await new Promise((r) => setTimeout(r, 3000));
}
