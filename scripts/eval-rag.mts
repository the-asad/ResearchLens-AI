/**
 * RAG evaluation harness — runs against REAL processed papers in Supabase, as the owning user
 * (RLS-impersonated Postgres connection; same SQL functions as the app).
 *
 *   npm run eval:rag -- --document <uuid> [--dataset eval/datasets/x.json] [--full]
 *
 * Retrieval metrics (per variant): Hit@1/3/5, Recall@5/10, MRR, nDCG@10.
 * --full also runs reranking + grounded generation and reports answer correctness (string
 * containment), citation validity, abstention behaviour and latency.
 * Security probes: foreign project id and a foreign user id must retrieve nothing.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { connect, asUser } from "./lib/pg.mjs";
import { pgRetrievalStore } from "./lib/pg-store.mjs";
import { createGeminiEmbeddingProvider, toPgVector } from "../src/lib/rag/embeddings";
import { reciprocalRankFusion, dedupeCandidates } from "../src/lib/rag/retrieval";
import { ask, type AskResult } from "../src/lib/rag/pipeline";
import { RETRIEVAL } from "../src/lib/rag/config";
import { hitAtK, mean, ndcgAtK, percentile, recallAtK, reciprocalRank } from "../src/lib/rag/eval-metrics";

const { values } = parseArgs({
  options: {
    document: { type: "string" },
    dataset: { type: "string", default: "eval/datasets/attention-is-all-you-need.json" },
    full: { type: "boolean", default: false },
    "pace-ms": { type: "string", default: "0" },
  },
});
if (!values.document) throw new Error("--document <uuid> is required");

type Q = { id: string; scenario: string; question: string; pages?: number[]; evidence?: string[]; answer_contains?: string[]; unanswerable?: boolean };
const dataset = JSON.parse(await readFile(values.dataset!, "utf8")) as { paper: string; questions: Q[] };

const db = await connect();
const [doc] = (await db.query("select id, owner_id, project_id, status, title from public.documents where id = $1", [values.document])).rows;
if (!doc) throw new Error("document not found");
if (doc.status !== "ready") throw new Error(`document status is ${doc.status}; process it first`);
const userId: string = doc.owner_id;
const store = pgRetrievalStore(db, userId);
const embedder = createGeminiEmbeddingProvider(process.env.GEMINI_API_KEY!);

const chunks = await asUser<{ id: string; page_start: number; page_end: number; content: string }>(
  db, userId, "select id, page_start, page_end, content from public.document_chunks where document_id = $1 order by chunk_index", [doc.id]);
const relevantFor = (q: Q) =>
  new Set(chunks.filter((c) => (q.pages ?? []).some((p) => p >= c.page_start && p <= c.page_end) && (q.evidence ?? []).some((e) => c.content.includes(e))).map((c) => c.id));

const answerable = dataset.questions.filter((q) => !q.unanswerable);
const missingLabels = answerable.filter((q) => relevantFor(q).size === 0).map((q) => q.id);
if (missingLabels.length) console.warn(`WARNING: no relevant chunk matches labels for ${missingLabels.join(", ")}`);

// ---------------------------------------------------------------------------
// Retrieval variants
// ---------------------------------------------------------------------------
type Variant = "dense" | "lexical" | "hybrid_rrf" | "hybrid_rrf_rerank";
const rankings: Record<Variant, Record<string, string[]>> = { dense: {}, lexical: {}, hybrid_rrf: {}, hybrid_rrf_rerank: {} };
const retrievalLatency: number[] = [];
const embedLatency: number[] = [];

for (const q of answerable) {
  const t0 = performance.now();
  const vec = toPgVector(await embedder.embedQuery(q.question));
  const t1 = performance.now();
  const [dense, lexical] = await Promise.all([
    store.dense({ embedding: vec, projectId: doc.project_id, model: embedder.model, documentIds: [doc.id], k: RETRIEVAL.DENSE_K }),
    store.lexical({ query: q.question, projectId: doc.project_id, documentIds: [doc.id], k: RETRIEVAL.LEXICAL_K }),
  ]);
  embedLatency.push(t1 - t0);
  retrievalLatency.push(performance.now() - t1);
  const fused = dedupeCandidates(reciprocalRankFusion(dense, lexical));
  rankings.dense[q.id] = dense.map((d) => d.chunk_id);
  rankings.lexical[q.id] = lexical.map((d) => d.chunk_id);
  rankings.hybrid_rrf[q.id] = fused.map((d) => d.chunk_id);
}

const computeMetrics = () => (Object.keys(rankings) as Variant[])
  .filter((v) => Object.keys(rankings[v]).length > 0)
  .map((v) => {
    const per = answerable.filter((q) => rankings[v][q.id] !== undefined).map((q) => ({ r: rankings[v][q.id], rel: relevantFor(q) }));
    return {
      variant: v,
      n: per.length,
      "Recall@1": mean(per.map((p) => recallAtK(p.r, p.rel, 1))),
      "Recall@3": mean(per.map((p) => recallAtK(p.r, p.rel, 3))),
      "Recall@5": mean(per.map((p) => recallAtK(p.r, p.rel, 5))),
      "Hit@1": mean(per.map((p) => hitAtK(p.r, p.rel, 1))),
      "Hit@3": mean(per.map((p) => hitAtK(p.r, p.rel, 3))),
      "Hit@5": mean(per.map((p) => hitAtK(p.r, p.rel, 5))),
      MRR: mean(per.map((p) => reciprocalRank(p.r, p.rel))),
      "nDCG@5": mean(per.map((p) => ndcgAtK(p.r, p.rel, 5))),
    };
  });

const computePerQuestion = () => answerable.map((q) => {
  const rel = relevantFor(q);
  const firstRank = (v: Variant) => {
    const i = (rankings[v][q.id] ?? []).findIndex((id) => rel.has(id));
    return i === -1 ? null : i + 1;
  };
  return { id: q.id, scenario: q.scenario, relevant: rel.size, dense: firstRank("dense"), lexical: firstRank("lexical"), hybrid: firstRank("hybrid_rrf"), reranked: rankings.hybrid_rrf_rerank[q.id] ? firstRank("hybrid_rrf_rerank") : "not reranked" };
});

// ---------------------------------------------------------------------------
// End-to-end (rerank + generation)
// ---------------------------------------------------------------------------
type E2E = {
  id: string; scenario: string; status: AskResult["status"]; sufficiency: string | null; correct: boolean | null; abstainedCorrectly: boolean | null;
  citations: number; invalidCitations: number; citedRelevant: boolean | null; ms: number; timings: Record<string, number>;
  rerank?: string; generator?: string; rerankMode: string; abstainReason?: string; error?: string;
};
const e2e: E2E[] = [];
const answerLog: { id: string; status: string; text: string }[] = [];
if (values.full) {
  const { llmRerank: rerank, llmGenerate: generate } = await import("../src/lib/rag/ai");
  const pace = Number(values["pace-ms"]) || 0;
  for (const [i, q] of dataset.questions.entries()) {
    if (i > 0 && pace > 0) await new Promise((r) => setTimeout(r, pace));
    const t0 = performance.now();
    let r: AskResult;
    try {
      r = await ask({ store, embedder, rerank, generate }, { query: q.question, projectId: doc.project_id, documentIds: [doc.id] });
    } catch (err) {
      e2e.push({ id: q.id, scenario: q.scenario, status: "unavailable", sufficiency: null, correct: q.unanswerable ? null : false, abstainedCorrectly: q.unanswerable ? false : null, citations: 0, invalidCitations: 0, citedRelevant: q.unanswerable ? null : false, ms: Math.round(performance.now() - t0), timings: {}, rerankMode: "error", error: (err as Error).name });
      console.log(`${q.id} ERROR ${(err as Error).name}`);
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    const rel = q.unanswerable ? new Set<string>() : relevantFor(q);
    const text = r.answer.toLowerCase();
    const stage = (m?: { requestedModel?: string; model: string; fallbackUsed: boolean; attempts?: string[] }) =>
      m ? `${m.requestedModel ?? "?"} → ${m.model}${m.fallbackUsed ? " (fallback)" : ""}` : undefined;
    if (!q.unanswerable && r.debug.rerankMode === "llm_grader") {
      // Configuration D: the exact graded pool that drove this answer (grade desc, then fused rank).
      const pool = r.ranked.filter((c) => c.rerank);
      const graded = [...pool].sort((a, b) => b.rerank!.grade - a.rerank!.grade || a.fusedRank - b.fusedRank);
      rankings.hybrid_rrf_rerank[q.id] = [...graded, ...r.ranked.filter((c) => !c.rerank)].map((c) => c.chunk_id);
    }
    e2e.push({
      id: q.id,
      scenario: q.scenario,
      status: r.status,
      sufficiency: r.sufficiency,
      correct: q.unanswerable ? null : r.status === "answered" && (q.answer_contains ?? []).every((s) => text.includes(s.toLowerCase())),
      abstainedCorrectly: q.unanswerable ? r.status === "insufficient" : null,
      citations: r.citations.length,
      invalidCitations: r.debug.invalidCitations.length,
      citedRelevant: q.unanswerable ? null : r.citations.some((c) => rel.has(c.chunkId)),
      ms,
      timings: r.debug.timings,
      rerank: stage(r.debug.providers.rerank),
      generator: stage(r.debug.providers.generate),
      rerankMode: r.debug.rerankMode,
      abstainReason: r.debug.generation?.abstainReason ?? (r.status === "insufficient" && r.sufficiency === "INSUFFICIENT" ? "insufficient_evidence" : undefined),
    });
    answerLog.push({ id: q.id, status: r.status, text: r.answer });
    console.log(`${q.id} ${r.status} ${r.sufficiency ?? ""} rerank=${r.debug.rerankMode} ${ms}ms ${e2e[e2e.length - 1].generator ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// Security probes (I, J)
// ---------------------------------------------------------------------------
const probeVec = toPgVector(await embedder.embedQuery("attention heads"));
const foreignProject = await store.scope(randomUUID());
const strangerStore = pgRetrievalStore(db, randomUUID());
const strangerDense = await strangerStore.dense({ embedding: probeVec, projectId: doc.project_id, model: embedder.model, documentIds: null, k: 50 });
const strangerLexical = await strangerStore.lexical({ query: "attention heads", projectId: doc.project_id, documentIds: null, k: 50 });
const strangerScope = await strangerStore.scope(doc.project_id);
const unauthorisedDoc = await ask({ store, embedder }, { query: "attention", projectId: doc.project_id, documentIds: [randomUUID()], retrievalOnly: true });
const security = {
  unknownProjectScope: foreignProject === null ? "PASS (no scope)" : "FAIL",
  unauthorisedDocumentId: unauthorisedDoc.status === "no_scope" ? "PASS (rejected before retrieval)" : "FAIL",
  crossUserScope: strangerScope === null ? "PASS (project invisible)" : "FAIL",
  crossUserDenseRows: strangerDense.length === 0 ? "PASS (0 rows)" : `FAIL (${strangerDense.length})`,
  crossUserLexicalRows: strangerLexical.length === 0 ? "PASS (0 rows)" : `FAIL (${strangerLexical.length})`,
};
await db.end();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const metricRows = computeMetrics();
const perQuestion = computePerQuestion();
const fmt = (n: number) => n.toFixed(3);
const ms = (xs: number[]) => `p50 ${Math.round(percentile(xs, 50))} ms · p95 ${Math.round(percentile(xs, 95))} ms · mean ${Math.round(mean(xs))} ms`;
const lines: string[] = [];
lines.push(`# RAG evaluation — ${dataset.paper}`, "", `Run: ${new Date().toISOString()} · chunks: ${chunks.length} · labelled answerable questions: ${answerable.length} · unanswerable: ${dataset.questions.length - answerable.length}`, "");
lines.push("Recall@K = fraction of the question's labelled-relevant chunks found in the top K (averaged). Hit@K = at least one relevant chunk in the top K.", "");
lines.push("## Retrieval", "", "| configuration | n | Recall@1 | Recall@3 | Recall@5 | Hit@1 | Hit@3 | Hit@5 | MRR | nDCG@5 |", "|---|---|---|---|---|---|---|---|---|---|");
for (const m of metricRows) lines.push(`| ${m.variant} | ${m.n} | ${fmt(m["Recall@1"])} | ${fmt(m["Recall@3"])} | ${fmt(m["Recall@5"])} | ${fmt(m["Hit@1"])} | ${fmt(m["Hit@3"])} | ${fmt(m["Hit@5"])} | ${fmt(m.MRR)} | ${fmt(m["nDCG@5"])} |`);
lines.push("", `Query embedding latency: ${ms(embedLatency)}`, `Dense + lexical SQL latency (parallel): ${ms(retrievalLatency)}`, "");
lines.push("### First relevant rank per question", "", "| id | scenario | #relevant | dense | lexical | hybrid | hybrid+rerank |", "|---|---|---|---|---|---|---|");
for (const p of perQuestion) lines.push(`| ${p.id} | ${p.scenario} | ${p.relevant} | ${p.dense ?? "—"} | ${p.lexical ?? "—"} | ${p.hybrid ?? "—"} | ${p.reranked ?? "—"} |`);
if (e2e.length) {
  const ans = e2e.filter((e) => e.correct !== null);
  const un = e2e.filter((e) => e.abstainedCorrectly !== null);
  const answered = e2e.filter((e) => e.status === "answered");
  const t = (k: string) => e2e.map((e) => e.timings[k]).filter((x): x is number => typeof x === "number");
  lines.push("", "## End-to-end grounded answers", "");
  lines.push(`- Answerable questions answered correctly (all expected facts present + cited): ${ans.filter((e) => e.correct && e.citedRelevant).length}/${ans.length}`);
  lines.push(`- Answerable questions answered with expected facts (any citation): ${ans.filter((e) => e.correct).length}/${ans.length}`);
  lines.push(`- Answers citing ≥1 labelled-relevant chunk: ${ans.filter((e) => e.citedRelevant).length}/${ans.length}`);
  lines.push(`- False abstentions on answerable questions: ${ans.filter((e) => e.status === "insufficient").length}/${ans.length}`);
  lines.push(`- Correct abstention on unanswerable questions: ${un.filter((e) => e.abstainedCorrectly).length}/${un.length}`);
  lines.push(`- Citations returned to the user: ${answered.reduce((n, e) => n + e.citations, 0)} — all validated against supplied, authorised, page-bearing evidence`);
  lines.push(`- Fabricated / invalid citation ids produced by the model and removed: ${e2e.reduce((n, e) => n + e.invalidCitations, 0)}`);
  lines.push(`- Sufficiency decisions: ${["SUFFICIENT", "WEAK", "INSUFFICIENT"].map((k) => `${k} ${e2e.filter((e) => e.sufficiency === k).length}`).join(" · ")}`);
  lines.push(`- Reranker mode: ${["llm_grader", "fusion_fallback", "error"].map((k) => `${k} ${e2e.filter((e) => e.rerankMode === k).length}`).join(" · ")}`);
  lines.push(`- Generation unavailable (all providers failed): ${e2e.filter((e) => e.status === "unavailable").length}/${e2e.length}`);
  lines.push("", "Latency (per query, end-to-end pipeline):", "");
  for (const k of ["embed_query_ms", "dense_ms", "lexical_ms", "rerank_ms", "expand_ms", "generate_ms", "total_ms"]) if (t(k).length) lines.push(`- ${k}: ${ms(t(k))} (n=${t(k).length})`);
  lines.push("", "| id | scenario | status | sufficiency | correct | abstained ok | citations | cited relevant | invalid ids | total ms | reranker (requested → actual) | generator (requested → actual) |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const e of e2e) lines.push(`| ${e.id} | ${e.scenario} | ${e.status} | ${e.sufficiency ?? "—"} | ${e.correct ?? "—"} | ${e.abstainedCorrectly ?? "—"} | ${e.citations} | ${e.citedRelevant ?? "—"} | ${e.invalidCitations} | ${e.timings.total_ms ?? e.ms} | ${e.rerank ?? "—"} | ${e.generator ?? "—"} |`);
}
lines.push("", "## Security probes", "", ...Object.entries(security).map(([k, v]) => `- ${k}: ${v}`));
const answers = e2e.length ? await Promise.resolve(answerLog) : [];
if (answers.length) lines.push("", "## Answers (verbatim, truncated)", "", ...answers.map((a) => `- **${a.id}** (${a.status}): ${a.text.replace(/\n+/g, " ").slice(0, 400)}`));
const report = lines.join("\n");
console.log("\n" + report);
await mkdir("eval/results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`eval/results/${stamp}${values.full ? "-full" : ""}.md`, report + "\n");
await writeFile(`eval/results/${stamp}${values.full ? "-full" : ""}.json`, JSON.stringify({ metricRows, perQuestion, e2e, security }, null, 2));
