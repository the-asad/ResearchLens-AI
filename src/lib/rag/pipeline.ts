/**
 * Query pipeline (framework-free; dependencies injected):
 *
 *   scope check → query embedding → dense + lexical → RRF → dedupe → rerank (LLM grader)
 *   → sufficiency → neighbour expansion → grounded generation → citation validation
 *
 * Abstains when evidence is insufficient instead of letting the model answer from general
 * knowledge. Produces a debug trace containing only the caller's own (RLS-scoped) data.
 */
import { RETRIEVAL } from "./config";
import { estimateTokens } from "./chunker";
import { toPgVector, type EmbeddingProvider } from "./embeddings";
import { dedupeCandidates, reciprocalRankFusion } from "./retrieval";
import { assessCrossPaperSufficiency, assessSufficiency, selectEvidence, selectEvidenceDiverse } from "./sufficiency";
import { analyzeQuery } from "./query-features";
import { validateCitations, validateSentences, type CitedSentence, type ValidatedCitation } from "./citations";
import type { Candidate, EvidencePassageOut, RetrievalStore, ScopedDocument, Sufficiency } from "./types";
import { createLruCache, normalizeQuery, scopedKey } from "./cache";

/** Per-instance caches (keys always include the user scope and model/version). */
const queryEmbeddingCache = createLruCache<number[]>(500, 60 * 60 * 1000);
const rerankCache = createLruCache<{ grades: Record<string, number>; meta: StageMeta }>(300, 30 * 60 * 1000);
export function clearRagCaches() {
  queryEmbeddingCache.clear();
  rerankCache.clear();
}

/** API / model usage for one question (shown in debug and evaluation output). */
export type Usage = {
  embeddingCalls: number;
  embeddingCacheHits: number;
  rerankCalls: number;
  rerankCacheHits: number;
  llmRequests: number; // provider HTTP requests actually made (incl. failed attempts)
  llmSkipped: number; // attempts skipped because a model was known-unavailable
  fallbacks: number;
};

export const RERANK_CHAR_BUDGET = 18_000;

export const ABSTENTION_MESSAGE =
  "I couldn't find sufficient evidence in the selected research papers to answer this reliably.";

/** Non-sensitive provider metadata for one LLM stage. */
export type StageMeta = { requestedProvider?: string; requestedModel?: string; provider: string; model: string; fallbackUsed: boolean; latencyMs: number; attempts?: string[] };

export type RerankFn = (query: string, candidates: { id: string; title: string; section: string | null; page: number | null; text: string }[]) => Promise<{
  grades: Record<string, number>;
  meta: StageMeta;
}>;

export type GenerateFn = (query: string, evidence: EvidencePassageOut[], sufficiency: Sufficiency) => Promise<{
  answerable: boolean;
  /** Free-text answer with inline [E#] markers (legacy / fallback form). */
  answer: string;
  /** Preferred: per-sentence structured citations. When present, it is the source of truth. */
  sentences?: CitedSentence[];
  meta: StageMeta;
}>;

export type AskInput = {
  query: string;
  projectId: string;
  documentIds?: string[] | null;
  /** Retrieval-only mode (evaluation): skip rerank + generation. */
  retrievalOnly?: boolean;
  /** Skip generation but still rerank (evaluation of the full ranking stack). */
  skipGeneration?: boolean;
};

export type DebugTrace = {
  query: string;
  projectId: string;
  documentIds: string[] | null;
  embeddingModel: string;
  denseStatus: "ok" | "unavailable";
  dense: { chunkId: string; rank: number; similarity: number; page: number | null; section: string | null }[];
  lexical: { chunkId: string; rank: number; score: number; page: number | null; section: string | null }[];
  fused: { chunkId: string; fusedRank: number; rrf: number; denseRank?: number; lexicalRank?: number; grade?: number; page: number | null; section: string | null }[];
  rerankMode: "llm_grader" | "fusion_fallback" | "skipped";
  sufficiency: Sufficiency | null;
  /** Deterministic query analysis (no LLM): drives cross-paper selection. */
  queryAnalysis?: { kind: string; multiPaper: boolean; evidenceDocuments?: number };
  final: { evidenceId: string; chunkId: string; role: string; grade?: number; pages: string; section: string | null }[];
  invalidCitations: string[];
  /** What the generator returned before validation (no text): helps diagnose false abstentions. */
  generation?: { answerable: boolean; citedIds: string[]; droppedSentences?: number; numericViolations?: number; abstainReason?: "model_declined" | "no_valid_citations" };
  timings: Record<string, number>;
  providers: Record<string, StageMeta>;
  usage: Usage;
};

export type AskResult = {
  status: "answered" | "insufficient" | "unavailable" | "no_scope" | "no_documents";
  answer: string;
  sufficiency: Sufficiency | null;
  citations: ValidatedCitation[];
  evidence: EvidencePassageOut[];
  /** Fused candidates in rank order (used by the evaluation harness). */
  ranked: Candidate[];
  debug: DebugTrace;
};

export async function ask(
  deps: {
    store: RetrievalStore;
    embedder: EmbeddingProvider;
    rerank?: RerankFn;
    /** Identifies the reranker implementation/version for cache keys. */
    rerankerId?: string;
    generate?: GenerateFn;
    /** Tenant scope for caches (user id). Without it, nothing is cached. */
    cacheScope?: string;
    log?: (e: Record<string, unknown>) => void;
  },
  input: AskInput,
): Promise<AskResult> {
  const timings: Record<string, number> = {};
  const startedAt = performance.now();
  const time = async <T>(name: string, fn: () => Promise<T>) => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };
  const debug: DebugTrace = {
    query: input.query,
    projectId: input.projectId,
    documentIds: input.documentIds ?? null,
    embeddingModel: deps.embedder.model,
    denseStatus: "ok",
    dense: [],
    lexical: [],
    fused: [],
    rerankMode: "skipped",
    sufficiency: null,
    final: [],
    invalidCitations: [],
    timings,
    providers: {},
    usage: { embeddingCalls: 0, embeddingCacheHits: 0, rerankCalls: 0, rerankCacheHits: 0, llmRequests: 0, llmSkipped: 0, fallbacks: 0 },
  };
  const countLlm = (m?: StageMeta) => {
    if (!m || m.provider === "local") return; // local models make no API calls
    const attempts = m.attempts ?? [];
    debug.usage.llmRequests += attempts.filter((a) => !a.includes(":skipped")).length || 1;
    debug.usage.llmSkipped += attempts.filter((a) => a.includes(":skipped")).length;
    if (m.fallbackUsed) debug.usage.fallbacks++;
  };
  const result = (r: Omit<AskResult, "debug">): AskResult => {
    timings.total_ms = Math.round(performance.now() - startedAt);
    deps.log?.({ event: "rag.ask", status: r.status, sufficiency: r.sufficiency, candidates: debug.fused.length, final: debug.final.length, ...timings });
    return { ...r, debug };
  };

  // 1. Authorisation of scope — before any retrieval. Unknown/foreign project → nothing.
  const docs = await time("scope_ms", () => deps.store.scope(input.projectId));
  if (!docs) return result({ status: "no_scope", answer: "That project was not found.", sufficiency: null, citations: [], evidence: [], ranked: [] });
  const ready = docs.filter((d) => d.status === "ready");
  let documentIds: string[] | null = null;
  if (input.documentIds?.length) {
    const allowed = new Set(ready.map((d) => d.id));
    if (!input.documentIds.every((id) => allowed.has(id))) {
      return result({ status: "no_scope", answer: "One or more selected documents are not available in this project.", sufficiency: null, citations: [], evidence: [], ranked: [] });
    }
    documentIds = input.documentIds;
  }
  if (ready.length === 0) {
    return result({ status: "no_documents", answer: "No processed papers in this project yet. Process a paper first.", sufficiency: null, citations: [], evidence: [], ranked: [] });
  }
  const scopedDocs = documentIds ? ready.filter((d) => documentIds!.includes(d.id)) : ready;
  const titles = new Map<string, ScopedDocument>(scopedDocs.map((d) => [d.id, d]));
  const authorised = new Set(scopedDocs.map((d) => d.id));

  // 2. Retrieve: dense and lexical in parallel. Dense failure degrades to lexical-only.
  const [dense, lexical] = await Promise.all([
    time("dense_ms", async () => {
      try {
        const qKey = deps.cacheScope ? scopedKey([deps.cacheScope, deps.embedder.model, deps.embedder.dimensions, normalizeQuery(input.query)]) : null;
        let vector = qKey ? queryEmbeddingCache.get(qKey) : undefined;
        if (vector) debug.usage.embeddingCacheHits++;
        else {
          vector = await time("embed_query_ms", () => deps.embedder.embedQuery(input.query));
          debug.usage.embeddingCalls++;
          if (qKey) queryEmbeddingCache.set(qKey, vector);
        }
        return await deps.store.dense({ embedding: toPgVector(vector), projectId: input.projectId, model: deps.embedder.model, documentIds, k: RETRIEVAL.DENSE_K });
      } catch {
        debug.denseStatus = "unavailable";
        return [];
      }
    }),
    time("lexical_ms", () => deps.store.lexical({ query: input.query, projectId: input.projectId, documentIds, k: RETRIEVAL.LEXICAL_K })),
  ]);
  // Defence in depth: drop anything outside the authorised scope (should never happen).
  const inScope = <T extends { document_id: string }>(rows: T[]) => rows.filter((r) => authorised.has(r.document_id));
  const denseHits = inScope(dense);
  const lexicalHits = inScope(lexical);
  debug.dense = denseHits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, similarity: round(h.similarity), page: h.page_start, section: h.section_title }));
  debug.lexical = lexicalHits.map((h, i) => ({ chunkId: h.chunk_id, rank: i + 1, score: round(h.rank), page: h.page_start, section: h.section_title }));

  const fused = dedupeCandidates(reciprocalRankFusion(denseHits, lexicalHits));
  fused.forEach((c, i) => (c.fusedRank = i + 1));
  const writeFusedDebug = () =>
    (debug.fused = fused.map((c) => ({
      chunkId: c.chunk_id,
      fusedRank: c.fusedRank,
      rrf: round(c.rrf, 5),
      denseRank: c.dense?.rank,
      lexicalRank: c.lexical?.rank,
      grade: c.rerank?.grade,
      page: c.page_start,
      section: c.section_title,
    })));
  writeFusedDebug();

  if (input.retrievalOnly || fused.length === 0) {
    const status = fused.length === 0 ? "insufficient" : "answered";
    return result({ status, answer: fused.length === 0 ? ABSTENTION_MESSAGE : "", sufficiency: fused.length === 0 ? "INSUFFICIENT" : null, citations: [], evidence: [], ranked: fused });
  }

  // 3. Rerank a bounded candidate set.
  const features = analyzeQuery(input.query);
  debug.queryAnalysis = { kind: features.kind, multiPaper: features.multiPaper };
  const pool = fused.slice(0, RETRIEVAL.RERANK_CANDIDATES);
  let sufficiency: Sufficiency;
  let selected: Candidate[];
  if (deps.rerank) {
    try {
      const ids = pool.map((_, i) => `C${i + 1}`);
      // Budget passage text across candidates (~18k chars ≈ 4.5k tokens) so the grader request also
      // fits the smallest fallback model's limits (Groq free tier: 8k tokens/min).
      const perPassage = Math.min(2400, Math.floor(RERANK_CHAR_BUDGET / Math.max(1, pool.length)));
      const candidates = pool.map((c, i) => ({ id: ids[i], title: titles.get(c.document_id)?.title ?? "Untitled", section: c.section_title, page: c.page_start, text: c.content.slice(0, perPassage) }));
      const rKey = deps.cacheScope
        ? scopedKey([deps.cacheScope, input.projectId, deps.rerankerId ?? "default", normalizeQuery(input.query), ...pool.map((c) => `${c.chunk_id}:${scopedKey([c.content])}`)])
        : null;
      const cachedRerank = rKey ? rerankCache.get(rKey) : undefined;
      const { grades, meta } = cachedRerank ?? (await time("rerank_ms", () => deps.rerank!(input.query, candidates)));
      if (cachedRerank) debug.usage.rerankCacheHits++;
      else {
        debug.usage.rerankCalls++;
        countLlm(meta);
        if (rKey) rerankCache.set(rKey, { grades, meta });
      }
      debug.providers.rerank = meta;
      debug.rerankMode = "llm_grader";
      pool.forEach((c, i) => (c.rerank = { grade: clampGrade(grades[ids[i]]) }));
      if (features.multiPaper) {
        const cross = assessCrossPaperSufficiency(pool);
        sufficiency = cross.sufficiency;
        debug.queryAnalysis = { kind: features.kind, multiPaper: true, evidenceDocuments: cross.documents };
        selected = selectEvidenceDiverse(pool, RETRIEVAL.FINAL_K);
      } else {
        sufficiency = assessSufficiency(pool);
        selected = selectEvidence(pool, RETRIEVAL.FINAL_K);
      }
    } catch {
      // Reranker unavailable: fall back to fusion order. Sufficiency is unknown, so treat as
      // WEAK and let the generator abstain if the passages do not support an answer.
      debug.rerankMode = "fusion_fallback";
      sufficiency = "WEAK";
      selected = pool.slice(0, RETRIEVAL.FINAL_K);
    }
  } else {
    debug.rerankMode = "fusion_fallback";
    sufficiency = "WEAK";
    selected = pool.slice(0, RETRIEVAL.FINAL_K);
  }
  writeFusedDebug();
  debug.sufficiency = sufficiency;

  if (sufficiency === "INSUFFICIENT") {
    return result({ status: "insufficient", answer: ABSTENTION_MESSAGE, sufficiency, citations: [], evidence: [], ranked: fused });
  }

  // 4. Controlled neighbour expansion.
  const evidence = await time("expand_ms", () => buildEvidence(deps.store, selected, pool, titles));
  if (deps.store.details && evidence.length) {
    const det = new Map((await deps.store.details(evidence.map((e) => e.chunkId))).map((d) => [d.chunk_id, d]));
    for (const e of evidence) {
      const d = det.get(e.chunkId);
      if (d) Object.assign(e, { contentType: d.content_type, derivation: d.derivation, structured: d.structured, bbox: d.bbox, hasAsset: d.has_asset, confidence: d.confidence });
    }
  }
  debug.final = evidence.map((e) => ({
    evidenceId: e.evidenceId,
    chunkId: e.chunkId,
    role: e.role,
    grade: e.grade,
    pages: e.pageStart === e.pageEnd ? `${e.pageStart}` : `${e.pageStart}-${e.pageEnd}`,
    section: e.section,
  }));

  if (input.skipGeneration || !deps.generate) {
    return result({ status: "answered", answer: "", sufficiency, citations: [], evidence, ranked: fused });
  }

  // 5. Grounded generation + programmatic citation validation.
  let gen: Awaited<ReturnType<GenerateFn>>;
  try {
    gen = await time("generate_ms", () => deps.generate!(input.query, evidence, sufficiency));
  } catch {
    // Every generation provider failed. Do not fabricate an answer; return the evidence found.
    return result({ status: "unavailable", answer: "The answer generator is temporarily unavailable. The retrieved evidence is shown below.", sufficiency, citations: [], evidence, ranked: fused });
  }
  debug.providers.generate = gen.meta;
  countLlm(gen.meta);
  const citedIds = gen.sentences
    ? [...new Set(gen.sentences.flatMap((x) => x.evidenceIds))]
    : [...new Set([...gen.answer.matchAll(/E\d{1,3}/g)].map((m) => m[0]))];
  if (!gen.answerable) {
    debug.generation = { answerable: false, citedIds, abstainReason: "model_declined" };
    return result({ status: "insufficient", answer: ABSTENTION_MESSAGE, sufficiency, citations: [], evidence, ranked: fused });
  }
  const checked = gen.sentences
    ? validateSentences(gen.sentences, evidence, authorised)
    : { ...validateCitations(gen.answer, evidence, authorised), droppedSentences: undefined, numericViolations: undefined };
  debug.invalidCitations = checked.invalid;
  if (checked.citations.length === 0 || !checked.text.trim()) {
    // An "answer" with no verifiable citation is not evidence-grounded: abstain.
    debug.generation = { answerable: true, citedIds, droppedSentences: checked.droppedSentences, numericViolations: checked.numericViolations, abstainReason: "no_valid_citations" };
    return result({ status: "insufficient", answer: ABSTENTION_MESSAGE, sufficiency, citations: [], evidence, ranked: fused });
  }
  debug.generation = { answerable: true, citedIds, droppedSentences: checked.droppedSentences, numericViolations: checked.numericViolations };
  return result({ status: "answered", answer: checked.text, sufficiency, citations: checked.citations, evidence, ranked: fused });
}

function clampGrade(g: unknown) {
  const n = typeof g === "number" ? Math.round(g) : 0;
  return Math.max(0, Math.min(3, n));
}

function round(n: number, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Turn selected chunks into evidence passages. A neighbour (±1 chunk, same document AND same
 * section) is added only when the selected chunk is short (< 200 tokens) or the neighbour was
 * itself graded relevant-ish (≥ 1) — never blindly. Total size is capped by a token budget and
 * passages are ordered in reading order so the generator sees coherent context.
 */
async function buildEvidence(
  store: RetrievalStore,
  selected: Candidate[],
  pool: Candidate[],
  titles: Map<string, ScopedDocument>,
): Promise<EvidencePassageOut[]> {
  type P = { hit: Candidate | (Omit<Candidate, "rrf" | "fusedRank"> & { rrf?: number }); role: "primary" | "context" };
  const chosen = new Map<string, P>();
  for (const c of selected) chosen.set(c.chunk_id, { hit: c, role: "primary" });

  let budget = RETRIEVAL.MAX_EVIDENCE_TOKENS - selected.reduce((n, c) => n + estimateTokens(c.content), 0);
  let expansions = 0;
  const poolGrade = new Map(pool.map((c) => [`${c.document_id}:${c.chunk_index}`, c.rerank?.grade ?? -1]));

  for (const c of selected.slice(0, 3)) {
    if (expansions >= RETRIEVAL.MAX_EXPANSIONS || budget <= 0) break;
    const neighbors = await store.neighbors(c.document_id, [c.chunk_index - 1, c.chunk_index + 1]);
    for (const n of neighbors) {
      if (chosen.has(n.chunk_id) || n.section_title !== c.section_title) continue;
      const short = estimateTokens(c.content) < 200;
      const relevant = (poolGrade.get(`${n.document_id}:${n.chunk_index}`) ?? -1) >= 1;
      const cost = n.token_count ?? estimateTokens(n.content);
      if (!(short || relevant) || cost > budget || expansions >= RETRIEVAL.MAX_EXPANSIONS) continue;
      chosen.set(n.chunk_id, { hit: { ...n, rrf: 0 } as P["hit"], role: "context" });
      budget -= cost;
      expansions++;
    }
  }

  const ordered = [...chosen.values()].sort(
    (a, b) => a.hit.document_id.localeCompare(b.hit.document_id) || a.hit.chunk_index - b.hit.chunk_index,
  );
  return dedupeCandidates(ordered.map((p) => ({ ...p, content: p.hit.content }))).map((p, i) => ({
    evidenceId: `E${i + 1}`,
    chunkId: p.hit.chunk_id,
    documentId: p.hit.document_id,
    documentTitle: titles.get(p.hit.document_id)?.title ?? "Untitled",
    pageStart: p.hit.page_start,
    pageEnd: p.hit.page_end,
    section: p.hit.section_title,
    content: p.hit.content,
    role: p.role,
    grade: "rerank" in p.hit ? p.hit.rerank?.grade : undefined,
  }));
}
