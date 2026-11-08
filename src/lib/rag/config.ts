/**
 * RAG configuration. Defaults are deliberate (see docs/RAG.md); each can be overridden with an
 * environment variable of the same name for experiments.
 */
function num(name: string, fallback: number) {
  const raw = typeof process !== "undefined" ? process.env[name] : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CHUNKING = {
  /** ~1–2 typical research-paper paragraphs: one idea per chunk keeps similarity sharp. */
  CHUNK_TARGET_TOKENS: num("CHUNK_TARGET_TOKENS", 350),
  /** Lets a long paragraph stay whole instead of being cut mid-argument. */
  CHUNK_MAX_TOKENS: num("CHUNK_MAX_TOKENS", 600),
  /** Only used when a paragraph had to be split: ~1–2 sentences of carry-over. */
  CHUNK_OVERLAP_TOKENS: num("CHUNK_OVERLAP_TOKENS", 60),
  /** Trailing fragments smaller than this merge into the previous chunk of the same section. */
  CHUNK_MIN_TOKENS: num("CHUNK_MIN_TOKENS", 80),
  VERSION: "structure-v1",
} as const;

export const EMBEDDING = {
  MODEL: (typeof process !== "undefined" && process.env.EMBEDDING_MODEL) || "gemini-embedding-2",
  /** Must equal the vector(N) column. Verified at runtime on every response. */
  DIMENSIONS: 768,
  /** Gemini batchEmbedContents accepts up to 100 inputs per request. */
  BATCH_SIZE: num("EMBEDDING_BATCH_SIZE", 50),
  /** Items per minute per process (Gemini free tier: 100 embed requests/min/model, each batch item counts). */
  PER_MINUTE: num("EMBEDDING_PER_MINUTE", 90),
  MAX_INPUT_CHARS: 24_000, // ~6k tokens, well under the model's 8,192-token input limit
} as const;

export const RETRIEVAL = {
  /** Candidates fetched from each retriever before fusion. */
  DENSE_K: num("RETRIEVAL_DENSE_K", 20),
  LEXICAL_K: num("RETRIEVAL_LEXICAL_K", 20),
  /** Reciprocal Rank Fusion constant (Cormack et al., 2009 use 60). */
  RRF_K: num("RETRIEVAL_RRF_K", 60),
  /** Fused candidates sent to the reranker. */
  RERANK_CANDIDATES: num("RETRIEVAL_RERANK_CANDIDATES", 16),
  /** Evidence passages kept after reranking (before neighbour expansion). */
  FINAL_K: num("RETRIEVAL_FINAL_K", 6),
  /** Max neighbour chunks added by context expansion. */
  MAX_EXPANSIONS: num("RETRIEVAL_MAX_EXPANSIONS", 3),
  /** Total evidence budget sent to the generator. */
  MAX_EVIDENCE_TOKENS: num("RETRIEVAL_MAX_EVIDENCE_TOKENS", 4500),
} as const;
