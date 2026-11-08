/**
 * ResearchLens evaluation lab — offline retrieval experiments on the public benchmark corpus.
 *   npx tsx --env-file=.env.local scripts/lab/run.mts --exp embeddings|chunking|retrieval|rerank|scaling
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connect } from "../lib/pg.mjs";
import { STRATEGIES, type LabChunk } from "./chunking.mjs";
import { embedders, type Embedder } from "./embedders.mjs";
import { RERANKERS } from "./rerankers.mjs";
import { analyzeQuery, fusionWeights } from "../../src/lib/rag/query-features";
import { embeddingText, estimateTokens } from "../../src/lib/rag/chunker";
import type { Block } from "../../src/lib/rag/pdf/types";
import { mean, percentile } from "../../src/lib/rag/eval-metrics";

const { values } = parseArgs({ options: {
  exp: { type: "string" }, embedder: { type: "string", default: "gemini-embedding-2@768" }, strategy: { type: "string", default: "section_v1" },
  retrieval: { type: "string", default: "adaptive" }, dataset: { type: "string", default: "eval/datasets/multi-paper-v1.json" },
} });

type Group = { paper: string; pages: number[]; evidence: string[] };
type Q = { id: string; type: string; question: string; groups?: Group[]; unanswerable?: boolean };
const manifest = JSON.parse(await readFile("eval/corpus/manifest.json", "utf8")) as { papers: { key: string; title: string }[] };
const titles = new Map(manifest.papers.map((p) => [p.key, p.title]));
const dataset = JSON.parse(await readFile(values.dataset!, "utf8")) as { questions: Q[] };
const answerable = dataset.questions.filter((q) => !q.unanswerable);
const blocks = new Map<string, Block[]>();
for (const p of manifest.papers) blocks.set(p.key, (JSON.parse(await readFile(`eval/cache/extract/${p.key}.json`, "utf8")) as { blocks: Block[] }).blocks);

const norm = (s: string) => s.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ");
const isRelevant = (u: LabChunk, g: Group) =>
  u.paper === g.paper && g.pages.some((p) => p >= u.pageStart && p <= u.pageEnd) && g.evidence.some((e) => norm(u.content).includes(norm(e)));

// ---------------------------------------------------------------------------- corpus/index
type Index = { strategy: string; units: LabChunk[]; byKey: Map<string, LabChunk>; vectors?: Map<string, number[]>; embedder?: Embedder; parents?: Map<string, LabChunk> };

async function buildIndex(strategyId: string, papers: string[]): Promise<Index> {
  const s = STRATEGIES.find((x) => x.id === strategyId)!;
  const units = papers.flatMap((p) => s.build(p, blocks.get(p)!));
  const idx: Index = { strategy: strategyId, units, byKey: new Map(units.map((u) => [u.key, u])) };
  if (strategyId === "parent_child") {
    const parents = papers.flatMap((p) => STRATEGIES[0].build(p, blocks.get(p)!));
    idx.parents = new Map(parents.map((u) => [u.key, u]));
  }
  return idx;
}

async function loadLexical(db: Awaited<ReturnType<typeof connect>>, idx: Index) {
  await db.query("delete from eval_lab.chunks where strategy = $1", [idx.strategy]);
  for (let i = 0; i < idx.units.length; i += 200) {
    const b = idx.units.slice(i, i + 200);
    await db.query(
      `insert into eval_lab.chunks (strategy, chunk_key, paper, chunk_index, page_start, page_end, section_title, content)
       select $1, * from unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::text[], $8::text[])`,
      [idx.strategy, b.map((u) => u.key), b.map((u) => u.paper), b.map((u) => u.index), b.map((u) => u.pageStart), b.map((u) => u.pageEnd), b.map((u) => u.section), b.map((u) => u.content)],
    );
  }
}

async function embedIndex(idx: Index, e: Embedder) {
  const t0 = performance.now();
  const texts = idx.units.map((u) => clip(embeddingText(titles.get(u.paper) ?? null, u), e));
  const vecs = await e.embed(texts, "document");
  idx.vectors = new Map(idx.units.map((u, i) => [u.key, vecs[i]]));
  idx.embedder = e;
  return Math.round(performance.now() - t0);
}
/** Keep inputs inside the model's context (~4 chars/token); recorded as a constraint, not hidden. */
function clip(t: string, e: Embedder) {
  return t.length > e.maxTokens * 4 ? t.slice(0, e.maxTokens * 4) : t;
}

// ---------------------------------------------------------------------------- retrieval
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function denseRank(idx: Index, qv: number[], papers: Set<string> | null, k = 50) {
  const scored: [string, number][] = [];
  for (const [key, v] of idx.vectors!) if (!papers || papers.has(idx.byKey.get(key)!.paper)) scored.push([key, dot(qv, v)]);
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k).map((x) => x[0]);
}

async function lexicalRank(db: Awaited<ReturnType<typeof connect>>, idx: Index, q: string, papers: string[] | null, k = 50) {
  const r = await db.query<{ chunk_key: string }>("select chunk_key from eval_lab.lexical($1, $2, $3, $4)", [idx.strategy, q, papers, k]);
  return r.rows.map((x) => x.chunk_key);
}

/** In-memory BM25 (k1=1.2, b=0.75) with simple lowercase alnum tokens — comparison arm only. */
function bm25Factory(idx: Index) {
  const tok = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9_\-.^]*/g) ?? [];
  const docs = idx.units.map((u) => tok(`${u.section ?? ""} ${u.content}`));
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1)));
  const avg = mean(docs.map((d) => d.length));
  const N = docs.length;
  return (q: string, papers: Set<string> | null, k = 50) => {
    const qt = [...new Set(tok(q))];
    const scored = idx.units.map((u, i) => {
      if (papers && !papers.has(u.paper)) return [u.key, -1] as [string, number];
      const tf = new Map<string, number>();
      for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of qt) {
        const f = tf.get(t) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        s += idf * ((f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * docs[i].length) / avg)));
      }
      return [u.key, s] as [string, number];
    });
    return scored.filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map((x) => x[0]);
  };
}

function fuse(lists: { keys: string[]; w: number }[], k = 60) {
  const s = new Map<string, number>();
  for (const { keys, w } of lists) keys.forEach((key, i) => s.set(key, (s.get(key) ?? 0) + w / (k + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}

/** Map children → parents for parent_child; dedupe preserving order. */
function toUnits(idx: Index, keys: string[]) {
  if (!idx.parents) return keys;
  const out: string[] = [];
  for (const k of keys) { const p = idx.byKey.get(k)!.parentKey!; if (!out.includes(p)) out.push(p); }
  return out;
}
const unitOf = (idx: Index, key: string) => (idx.parents ? idx.parents.get(key)! : idx.byKey.get(key)!);

// ---------------------------------------------------------------------------- metrics
type Row = Record<string, number | string>;
function scoreQuestion(idx: Index, q: Q, ranking: string[]) {
  const groups = q.groups!;
  const units = ranking.map((k) => unitOf(idx, k));
  const relAny = (u: LabChunk) => groups.some((g) => isRelevant(u, g));
  const coverage = (K: number) => groups.filter((g) => units.slice(0, K).some((u) => isRelevant(u, g))).length / groups.length;
  const first = units.findIndex(relAny);
  const allRelevantCount = [...(idx.parents ?? idx.byKey).values()].filter(relAny).length;
  const ndcg = (K: number) => {
    let dcg = 0;
    units.slice(0, K).forEach((u, i) => { if (relAny(u)) dcg += 1 / Math.log2(i + 2); });
    let idcg = 0;
    for (let i = 0; i < Math.min(allRelevantCount, K); i++) idcg += 1 / Math.log2(i + 2);
    return idcg ? dcg / idcg : 0;
  };
  const papers = new Set(groups.map((g) => g.paper));
  const top5 = units.slice(0, 5);
  return {
    "R@1": coverage(1), "R@3": coverage(3), "R@5": coverage(5), "R@10": coverage(10),
    MRR: first === -1 ? 0 : 1 / (first + 1), "nDCG@5": ndcg(5), "nDCG@10": ndcg(10),
    wrongDoc5: top5.length ? top5.filter((u) => !papers.has(u.paper)).length / top5.length : 0,
    precision5: top5.length ? top5.filter(relAny).length / top5.length : 0,
    ctxTokens5: top5.reduce((n, u) => n + estimateTokens(u.content), 0),
    labelled: allRelevantCount,
  };
}
function aggregate(rows: Record<string, number>[]) {
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((k) => [k, Math.round(mean(rows.map((r) => r[k])) * 1000) / 1000]));
}

// ---------------------------------------------------------------------------- runner
const db = await connect();
const allPapers = manifest.papers.map((p) => p.key);
const results: Row[] = [];
const perQuestion: Record<string, unknown>[] = [];

async function evaluate(label: Row, idx: Index, mode: string, qs: Q[], opts: { papers?: string[]; rerank?: (typeof RERANKERS)[number]; pool?: number } = {}) {
  const bm25 = mode.includes("bm25") ? bm25Factory(idx) : null;
  const scope = opts.papers ? new Set(opts.papers) : null;
  const rows: Record<string, number>[] = [];
  const lat = { embed: [] as number[], retrieve: [] as number[], rerank: [] as number[] };
  let rerankFailures = 0;
  for (const q of qs) {
    let t0 = performance.now();
    const qv = mode === "lexical" || mode === "bm25" ? null : (await idx.embedder!.embed([q.question], "query"))[0];
    lat.embed.push(performance.now() - t0);
    t0 = performance.now();
    const dense = qv ? denseRank(idx, qv, scope) : [];
    const lex = mode === "dense" || mode === "bm25" ? [] : await lexicalRank(db, idx, q.question, opts.papers ?? null);
    const bm = bm25 ? bm25(q.question, scope) : [];
    const f = analyzeQuery(q.question);
    const w = fusionWeights(f);
    let ranking =
      mode === "dense" ? dense
      : mode === "lexical" ? lex
      : mode === "bm25" ? bm
      : mode === "rrf" ? fuse([{ keys: dense, w: 1 }, { keys: lex, w: 1 }])
      : mode === "wrrf" ? fuse([{ keys: dense, w: 1 }, { keys: lex, w: 0.5 }])
      : mode === "adaptive" ? fuse([{ keys: dense, w: w.dense }, { keys: lex, w: w.lexical }])
      : mode === "adaptive_bm25" ? fuse([{ keys: dense, w: w.dense }, { keys: bm, w: w.lexical }])
      // Candidate expansion (not rank fusion): dense order first, then lexical hits dense missed.
      : mode === "union" ? [...dense.slice(0, 30), ...lex.filter((k) => !dense.slice(0, 30).includes(k)).slice(0, 10)]
      : mode === "union_bm25" ? [...dense.slice(0, 30), ...bm.filter((k) => !dense.slice(0, 30).includes(k)).slice(0, 10)]
      : dense;
    ranking = toUnits(idx, ranking);
    lat.retrieve.push(performance.now() - t0);
    if (opts.rerank) {
      t0 = performance.now();
      const pool = ranking.slice(0, opts.pool ?? 30);
      try {
        const scores = await opts.rerank.score(q.question, pool.map((k) => { const u = unitOf(idx, k); return `${titles.get(u.paper)} — ${u.section ?? ""}\n${u.content}`; }));
        const order = pool.map((k, i) => [k, scores[i]] as [string, number]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        ranking = [...order, ...ranking.slice(pool.length)];
        lat.rerank.push(performance.now() - t0);
      } catch (err) {
        rerankFailures++; // recorded, ranking falls back to the retrieval order for this question
        console.warn(JSON.stringify({ event: "lab.rerank_failed", id: q.id, error: (err as Error).name }));
      }
    }
    const s = scoreQuestion(idx, q, ranking);
    rows.push(s);
    perQuestion.push({ ...label, id: q.id, type: q.type, kind: f.kind, firstRelevant: s.MRR ? Math.round(1 / s.MRR) : null, "R@5": s["R@5"] });
  }
  const half = (odd: boolean) => aggregate(rows.filter((_, i) => (i % 2 === 1) === odd));
  const agg = aggregate(rows);
  const row: Row = {
    ...label, n: rows.length, ...agg,
    "MRR(even)": half(false).MRR, "MRR(odd)": half(true).MRR,
    embed_p50_ms: Math.round(percentile(lat.embed, 50)), retrieve_p50_ms: Math.round(percentile(lat.retrieve, 50)),
    ...(lat.rerank.length ? { rerank_p50_ms: Math.round(percentile(lat.rerank, 50)), rerank_p95_ms: Math.round(percentile(lat.rerank, 95)) } : {}),
    ...(opts.rerank ? { rerankFailures } : {}),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

const exp = values.exp;
const papersFor = (n: number) => ["bert", "roberta", "albert", "distilbert", "electra", "transformer", "xlnet", "t5", "reformer", "longformer", "linformer", "performer", "transformer_xl"].slice(0, n);
const getEmbedder = (id: string) => embedders().find((e) => e.id === id)!;

if (exp === "embeddings") {
  const idx = await buildIndex("section_v1", allPapers);
  for (const e of embedders()) {
    const ms = await embedIndex(idx, e);
    await evaluate({ exp, embedder: e.id, dims: e.dims, maxTokens: e.maxTokens, license: e.license, sizeMB: e.sizeMB, runtime: e.runtime, index_ms: ms, vectorMB: Math.round((idx.units.length * e.dims * 4) / 1e4) / 100 }, idx, "dense", answerable);
  }
}
if (exp === "chunking") {
  const e = getEmbedder(values.embedder!);
  for (const s of STRATEGIES) {
    const idx = await buildIndex(s.id, allPapers);
    await loadLexical(db, idx);
    await embedIndex(idx, e);
    const meta = { exp, strategy: s.id, embedder: e.id, units: idx.units.length, medTokens: percentile(idx.units.map((u) => estimateTokens(u.content)), 50), vectorMB: Math.round((idx.units.length * e.dims * 4) / 1e4) / 100 };
    await evaluate({ ...meta, retrieval: "dense" }, idx, "dense", answerable);
    await evaluate({ ...meta, retrieval: "adaptive" }, idx, "adaptive", answerable);
  }
}
if (exp === "retrieval") {
  const e = getEmbedder(values.embedder!);
  const idx = await buildIndex(values.strategy!, allPapers);
  await loadLexical(db, idx);
  await embedIndex(idx, e);
  for (const mode of ["dense", "lexical", "bm25", "rrf", "wrrf", "adaptive", "adaptive_bm25"]) await evaluate({ exp, embedder: e.id, strategy: idx.strategy, retrieval: mode }, idx, mode, answerable);
}
if (exp === "rerank") {
  const e = getEmbedder(values.embedder!);
  const idx = await buildIndex(values.strategy!, allPapers);
  await loadLexical(db, idx);
  await embedIndex(idx, e);
  await evaluate({ exp, embedder: e.id, retrieval: values.retrieval!, reranker: "none" }, idx, values.retrieval!, answerable);
  if (process.env.LLM_RERANK === "1") {
    // Baseline: production LLM grader (structured output), 16-candidate pool as in production.
    const { llmRerank } = await import("../../src/lib/rag/ai");
    const pace = Number(process.env.LAB_PACE_MS ?? 0);
    let calls = 0;
    const llm = {
      id: "llm-grader", license: "API", sizeMB: 0,
      async score(query: string, passages: string[]) {
        if (calls++ && pace) await new Promise((r) => setTimeout(r, pace));
        const per = Math.min(2400, Math.floor(18_000 / passages.length)); // same budget as production
        const { grades } = await llmRerank(query, passages.map((t, i) => ({ id: `C${i + 1}`, title: "", section: null, page: null, text: t.slice(0, per) })));
        return passages.map((_, i) => grades[`C${i + 1}`] ?? 0);
      },
    };
    await evaluate({ exp, embedder: e.id, retrieval: values.retrieval!, reranker: "llm-grader", pool: 16 }, idx, values.retrieval!, answerable, { rerank: llm, pool: 16 });
  }
  const only = process.env.RERANKERS?.split(",");
  for (const r of RERANKERS.filter((x) => !only || only.includes(x.id))) {
    await evaluate({ exp, embedder: e.id, retrieval: values.retrieval!, reranker: r.id, rerankerMB: r.sizeMB, license: r.license, pool: 40 }, idx, values.retrieval!, answerable, { rerank: r, pool: 40 });
  }
}
if (exp === "scaling") {
  const e = getEmbedder(values.embedder!);
  const bertQs = answerable.filter((q) => q.groups!.every((g) => g.paper === "bert"));
  for (const n of [1, 5, 10, 13]) {
    const papers = papersFor(n);
    const idx = await buildIndex(values.strategy!, allPapers);
    await loadLexical(db, idx);
    await embedIndex(idx, e);
    const eligible = answerable.filter((q) => q.groups!.every((g) => papers.includes(g.paper)));
    const units = idx.units.filter((u) => papers.includes(u.paper)).length;
    const base = { exp, papers: n, units, vectorMB: Math.round((units * e.dims * 4) / 1e4) / 100, retrieval: values.retrieval! };
    await evaluate({ ...base, questions: "fixed BERT-only set" }, idx, values.retrieval!, bertQs, { papers });
    await evaluate({ ...base, questions: "all eligible" }, idx, values.retrieval!, eligible, { papers });
  }
}

await db.end();
await mkdir("eval/results/lab", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`eval/results/lab/${exp}-${stamp}.json`, JSON.stringify({ results, perQuestion }, null, 2));
const cols = Object.keys(results[0] ?? {});
await writeFile(`eval/results/lab/${exp}-${stamp}.md`, `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n` + results.map((r) => `| ${cols.map((c) => r[c] ?? "").join(" | ")} |`).join("\n") + "\n");
console.log(`saved eval/results/lab/${exp}-${stamp}.{json,md}`);
