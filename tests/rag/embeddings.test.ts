import { describe, expect, it, vi } from "vitest";
import { createGeminiEmbeddingProvider, EmbeddingError, toPgVector } from "@/lib/rag/embeddings";

const vec = (d: number, v = 0.5) => Array.from({ length: d }, () => v);
const okResponse = (n: number, d = 768) => new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: vec(d) })) }), { status: 200 });
const noSleep = { sleep: async () => {}, baseDelayMs: 0 };

describe("Gemini embedding provider", () => {
  it("batches requests and preserves order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const n = JSON.parse(String(init!.body)).requests.length;
      return okResponse(n);
    });
    const p = createGeminiEmbeddingProvider("k", { batchSize: 2, fetchImpl: fetchImpl as unknown as typeof fetch, retry: noSleep, pacer: async () => {} });
    const out = await p.embedDocuments(["a", "b", "c", "d", "e"]);
    expect(out).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body.requests[0]).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 });
    expect(Math.hypot(...out[0])).toBeCloseTo(1); // normalised
  });

  it("never truncates or pads: wrong dimensionality is an error", async () => {
    const p = createGeminiEmbeddingProvider("k", { fetchImpl: (async () => okResponse(1, 3072)) as unknown as typeof fetch, retry: noSleep });
    await expect(p.embedQuery("q")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("L: retries transient failures (429/503) then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls < 3 ? new Response("{}", { status: 503 }) : okResponse(1))) as unknown as typeof fetch;
    const p = createGeminiEmbeddingProvider("k", { fetchImpl, retry: noSleep });
    expect(await p.embedQuery("q")).toHaveLength(768);
    expect(calls).toBe(3);
  });

  it("L: gives up after bounded retries with a transient error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const p = createGeminiEmbeddingProvider("k", { fetchImpl, retry: { ...noSleep, retries: 2 } });
    await expect(p.embedDocuments(["a"])).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toBe(3);
  });

  it("does not retry auth failures", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch;
    const p = createGeminiEmbeddingProvider("k", { fetchImpl, retry: noSleep });
    await expect(p.embedDocuments(["a"])).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toBe(1);
  });

  it("rejects empty and oversized inputs before calling the API", async () => {
    const fetchImpl = vi.fn();
    const p = createGeminiEmbeddingProvider("k", { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.embedDocuments(["ok", "  "])).rejects.toBeInstanceOf(EmbeddingError);
    await expect(p.embedDocuments(["x".repeat(30_000)])).rejects.toMatchObject({ kind: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("formats pgvector literals", () => expect(toPgVector([1, 0.25])).toBe("[1.0,0.25]"));
});

describe("free-tier pacing", () => {
  it("keeps items per minute under the limit and waits for the window", async () => {
    const { createPacer } = await import("@/lib/rag/embeddings");
    let t = 0;
    const waits: number[] = [];
    const take = createPacer(100, () => t, async (ms) => { waits.push(ms); t += ms; });
    await take(50);
    await take(50);
    expect(waits).toEqual([]);
    await take(50); // 150 > 100 within the minute → must wait ~60 s
    expect(waits.length).toBe(1);
    expect(t).toBeGreaterThanOrEqual(60_000);
  });

  it("honours Gemini's retryDelay hint on 429", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ error: { details: [{ retryDelay: "15s" }] } }), { status: 429 })
        : okResponse(1)) as unknown as typeof fetch;
    const p = createGeminiEmbeddingProvider("k", { fetchImpl, pacer: async () => {}, retry: { sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 1 } });
    await p.embedQuery("q");
    expect(sleeps[0]).toBe(15_000);
  });
});

describe("daily quota", () => {
  it("fails fast (no retries) when the reset hint is hours away", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { details: [{ retryDelay: "74812s" }] } }), { status: 429 });
    }) as unknown as typeof fetch;
    const p = createGeminiEmbeddingProvider("k", { fetchImpl, pacer: async () => {}, retry: { sleep: async () => {}, baseDelayMs: 1 } });
    await expect(p.embedDocuments(["a"])).rejects.toMatchObject({ kind: "quota", retryAfterMs: 74_812_000 });
    expect(calls).toBe(1);
  });
});
