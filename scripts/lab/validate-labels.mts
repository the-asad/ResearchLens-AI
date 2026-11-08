/** Every labelled evidence group must match ≥1 unit on its page in the production chunking. */
import { readFile } from "node:fs/promises";
import { STRATEGIES } from "./chunking.mjs";
import type { Block } from "../../src/lib/rag/pdf/types";
const ds = JSON.parse(await readFile(process.argv[2] ?? "eval/datasets/multi-paper-v1.json", "utf8")) as { questions: { id: string; groups?: { paper: string; pages: number[]; evidence: string[] }[] }[] };
const norm = (s: string) => s.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ");
const strategy = STRATEGIES.find((s) => s.id === (process.argv[3] ?? "section_v1"))!;
const cache = new Map<string, ReturnType<typeof strategy.build>>();
let bad = 0;
for (const q of ds.questions) for (const g of q.groups ?? []) {
  if (!cache.has(g.paper)) cache.set(g.paper, strategy.build(g.paper, (JSON.parse(await readFile(`eval/cache/extract/${g.paper}.json`, "utf8")) as { blocks: Block[] }).blocks));
  const hits = cache.get(g.paper)!.filter((u) => g.pages.some((p) => p >= u.pageStart && p <= u.pageEnd) && g.evidence.some((e) => norm(u.content).includes(norm(e))));
  if (!hits.length) { bad++; console.log(`NO MATCH ${q.id} ${g.paper} p${g.pages} ${JSON.stringify(g.evidence)}`); }
}
console.log(bad ? `${bad} unmatched groups` : "all groups matched");
