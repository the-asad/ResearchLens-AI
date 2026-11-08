/**
 * Embedding subsystem. One provider interface (embedDocuments / embedQuery); Gemini
 * `gemini-embedding-2` at 768 dimensions is the default implementation.
 *
 * Guarantees:
 *  - output order == input order (deterministic chunk ↔ vector mapping)
 *  - every vector has exactly the configured dimensionality (never truncated or padded here;
 *    a mismatch is an error)
 *  - empty / oversized inputs are rejected up front
 *  - bounded retries with exponential backoff for transient failures only
 */
import { EMBEDDING } from "./config";

export type EmbeddingProvider = {
  model: string;
  dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid_input" | "transient" | "quota" | "auth" | "invalid_response" | "unconfigured",
    /** Provider-supplied wait hint (e.g. Gemini RetryInfo.retryDelay). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Sliding-window pacer. Gemini's free tier counts EVERY text inside a batch as one request
 * (limit: 100/min/model), so batching saves round trips but not quota. The pacer keeps a
 * single process under `perMinute` items so multi-paper ingestion slows down instead of failing.
 */
export function createPacer(perMinute: number, now = () => Date.now(), sleep: (ms: number) => Promise<void> = defaultSleep) {
  const sent: { t: number; n: number }[] = [];
  return async function take(n: number) {
    for (;;) {
      const cutoff = now() - 60_000;
      while (sent.length && sent[0].t <= cutoff) sent.shift();
      const used = sent.reduce((a, x) => a + x.n, 0);
      if (used + n <= perMinute || sent.length === 0) {
        sent.push({ t: now(), n });
        return;
      }
      await sleep(sent[0].t - cutoff + 50);
    }
  };
}

type RetryOptions = { retries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Longest provider-requested wait honoured per retry. */
const MAX_RETRY_AFTER_MS = 65_000;
/** Reset hints longer than this indicate an exhausted daily quota, not a short rate limit. */
export const QUOTA_HINT_MS = 5 * 60_000;
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof EmbeddingError && err.kind === "transient";
      if (!transient || attempt >= retries) throw err;
      const hinted = err.retryAfterMs !== undefined && err.retryAfterMs <= MAX_RETRY_AFTER_MS ? err.retryAfterMs : 0;
      await sleep(Math.max(base * 2 ** attempt + Math.floor(Math.random() * 250), hinted));
    }
  }
}

export function validateInputs(texts: string[], maxChars: number) {
  texts.forEach((t, i) => {
    if (!t || !t.trim()) throw new EmbeddingError(`Embedding input ${i} is empty`, "invalid_input");
    if (t.length > maxChars) throw new EmbeddingError(`Embedding input ${i} exceeds ${maxChars} characters`, "invalid_input");
  });
}

export function assertDimensions(vectors: number[][], expected: number, count: number) {
  if (vectors.length !== count) {
    throw new EmbeddingError(`Expected ${count} embeddings, received ${vectors.length}`, "invalid_response");
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== expected) {
      throw new EmbeddingError(`Embedding has ${v?.length ?? 0} dimensions; expected ${expected}`, "invalid_response");
    }
    if (!v.every((x) => Number.isFinite(x))) throw new EmbeddingError("Embedding contains non-finite values", "invalid_response");
  }
}

/** L2-normalise (cosine-equivalent; makes vectors comparable across dimension settings). */
export function normalize(v: number[]) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function classify(status: number): EmbeddingError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "invalid_response";
}

export function createGeminiEmbeddingProvider(
  apiKey: string,
  opts: { model?: string; dimensions?: number; batchSize?: number; fetchImpl?: typeof fetch; retry?: RetryOptions; perMinute?: number; pacer?: (n: number) => Promise<void> } = {},
): EmbeddingProvider {
  const model = opts.model ?? EMBEDDING.MODEL;
  const dimensions = opts.dimensions ?? EMBEDDING.DIMENSIONS;
  const batchSize = Math.min(opts.batchSize ?? EMBEDDING.BATCH_SIZE, 100);
  const doFetch = opts.fetchImpl ?? fetch;
  const pace = opts.pacer ?? createPacer(opts.perMinute ?? EMBEDDING.PER_MINUTE);

  async function call(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") {
    await pace(texts.length);
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_BASE}/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: dimensions,
          })),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new EmbeddingError(`Embedding network error: ${(err as Error).name}`, "transient");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { details?: { retryDelay?: string }[] } };
      const delay = body.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      const retryAfterMs = delay ? Math.ceil(parseFloat(delay) * 1000) : undefined;
      // A reset hint longer than a few minutes means the DAILY quota is exhausted (observed: ~20 h).
      // Retrying would only stall the caller; fail fast with a quota error instead.
      const kind = res.status === 429 && retryAfterMs !== undefined && retryAfterMs > QUOTA_HINT_MS ? "quota" : classify(res.status);
      throw new EmbeddingError(`Embedding HTTP ${res.status}`, kind, retryAfterMs);
    }
    const json = (await res.json().catch(() => ({}))) as { embeddings?: { values?: number[] }[] };
    const vectors = (json.embeddings ?? []).map((e) => e.values ?? []);
    assertDimensions(vectors, dimensions, texts.length);
    return vectors.map(normalize);
  }

  return {
    model,
    dimensions,
    async embedDocuments(texts) {
      validateInputs(texts, EMBEDDING.MAX_INPUT_CHARS);
      const out: number[][] = [];
      // Sequential batches: bounded concurrency keeps us inside free-tier rate limits and
      // preserves order trivially.
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        // Ingestion is not latency-sensitive: ride out free-tier slowdowns rather than fail a paper.
        out.push(...(await withRetry(() => call(batch, "RETRIEVAL_DOCUMENT"), { retries: 10, ...opts.retry })));
      }
      return out;
    },
    async embedQuery(text) {
      validateInputs([text], 4000);
      const [v] = await withRetry(() => call([text], "RETRIEVAL_QUERY"), { retries: 2, ...opts.retry });
      return v;
    },
  };
}

/** pgvector text literal. */
export function toPgVector(v: number[]) {
  return `[${v.map((x) => (Number.isInteger(x) ? x.toFixed(1) : x.toString())).join(",")}]`;
}
