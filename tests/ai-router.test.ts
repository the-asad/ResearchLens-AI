import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetQuotaState, routeGeneration, type ProviderTarget } from "@/lib/ai/router";

// Health is process-wide by design; isolate tests from each other.
beforeEach(() => resetQuotaState());
import { AiProviderError, AiUnavailableError, classifyStatus } from "@/lib/ai/errors";

const base = { system: "s", input: "i", temperature: 0, maxOutputTokens: 10 };
const noSleep = { sleep: async () => {}, timeoutMs: 1000 };
const ok = (model: string) => async () => ({ text: "ok", model });
const fail = (kind: ConstructorParameters<typeof AiProviderError>[1], provider: "gemini" | "groq" = "gemini") =>
  async () => {
    throw new AiProviderError("x", kind, provider);
  };

describe("classifyStatus", () => {
  it("classifies statuses", () => {
    expect(classifyStatus(503)).toBe("transient");
    expect(classifyStatus(429)).toBe("transient");
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(400)).toBe("invalid_request");
  });
});

describe("routeGeneration", () => {
  it("uses the primary when it succeeds", async () => {
    const r = await routeGeneration([{ provider: "gemini", model: "p", retries: 2, call: ok("p-actual") }], base, noSleep);
    expect(r.metadata.fallbackUsed).toBe(false);
    expect(r.metadata.model).toBe("p-actual");
  });

  it("retries transient errors with bounded attempts, then falls back", async () => {
    const primary = vi.fn(fail("transient"));
    const r = await routeGeneration(
      [
        { provider: "gemini", model: "p", retries: 2, call: primary },
        { provider: "gemini", model: "f", retries: 1, call: ok("f") },
      ],
      base,
      noSleep,
    );
    expect(primary).toHaveBeenCalledTimes(3);
    expect(r.metadata.fallbackUsed).toBe(true);
    expect(r.metadata.model).toBe("f");
    expect(r.metadata.requestedModel).toBe("p");
  });

  it("does not retry auth failures and skips other models of that provider", async () => {
    const primary = vi.fn(fail("auth"));
    const geminiFallback = vi.fn(ok("f"));
    const r = await routeGeneration(
      [
        { provider: "gemini", model: "p", retries: 2, call: primary },
        { provider: "gemini", model: "f", retries: 1, call: geminiFallback },
        { provider: "groq", model: "g", retries: 1, call: ok("g") },
      ],
      base,
      noSleep,
    );
    expect(primary).toHaveBeenCalledTimes(1);
    expect(geminiFallback).not.toHaveBeenCalled();
    expect(r.metadata.provider).toBe("groq");
  });

  it("does not retry invalid requests", async () => {
    const primary = vi.fn(fail("invalid_request"));
    await routeGeneration(
      [
        { provider: "gemini", model: "p", retries: 2, call: primary },
        { provider: "groq", model: "g", retries: 0, call: ok("g") },
      ],
      base,
      noSleep,
    );
    expect(primary).toHaveBeenCalledTimes(1);
  });

  it("fails safely when every provider fails", async () => {
    const targets: ProviderTarget[] = [
      { provider: "gemini", model: "p", retries: 1, call: fail("transient") },
      { provider: "groq", model: "g", retries: 1, call: fail("transient", "groq") },
    ];
    await expect(routeGeneration(targets, base, noSleep)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("fails safely with no configured providers", async () => {
    await expect(routeGeneration([], base, noSleep)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe("quota and rate-limit handling", () => {
  it("classifies daily-quota 429s as quota, others as transient", async () => {
    const { classifyRateLimit, parseDurationMs } = await import("@/lib/ai/errors");
    expect(classifyRateLimit("Rate limit exceeded (limit: 20 requests per day on Free Tier)")).toBe("quota");
    expect(classifyRateLimit("Rate limit reached for tokens per minute")).toBe("transient");
    expect(parseDurationMs("2h51m31s")).toBe((2 * 3600 + 51 * 60 + 31) * 1000);
    expect(parseDurationMs("18.285s")).toBe(18285);
    expect(parseDurationMs("7")).toBe(7000);
  });

  it("does not retry an exhausted quota and skips that model on later requests", async () => {
    const { resetQuotaState } = await import("@/lib/ai/router");
    resetQuotaState();
    const exhausted = vi.fn(async () => {
      throw new AiProviderError("429", "quota", "gemini", 429, 3_600_000);
    });
    const targets: ProviderTarget[] = [
      { provider: "gemini", model: "p", retries: 2, call: exhausted },
      { provider: "groq", model: "g", retries: 0, call: ok("g") },
    ];
    await routeGeneration(targets, base, noSleep);
    expect(exhausted).toHaveBeenCalledTimes(1);
    const second = await routeGeneration(targets, base, noSleep);
    expect(exhausted).toHaveBeenCalledTimes(1); // circuit open: not called again
    expect(second.metadata.attempts[0]).toMatchObject({ model: "p", errorKind: "quota" });
    expect(second.metadata.fallbackUsed).toBe(true);
    resetQuotaState();
  });

  it("honours a short retry-after hint for transient rate limits", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const call = async () => {
      if (calls++ === 0) throw new AiProviderError("429", "transient", "groq", 429, 5000);
      return { text: "ok", model: "g" };
    };
    await routeGeneration([{ provider: "groq", model: "g", retries: 1, call }], base, { sleep: async (ms) => void sleeps.push(ms), timeoutMs: 1000 });
    expect(sleeps).toEqual([5000]);
  });
});

describe("provider health registry", () => {
  it("cools a model down after repeated transient failures and recovers on success", async () => {
    const { createHealthRegistry, COOLDOWN_AFTER_FAILURES, COOLDOWN_MS } = await import("@/lib/ai/health");
    let t = 0;
    const h = createHealthRegistry(() => t);
    for (let i = 0; i < COOLDOWN_AFTER_FAILURES; i++) h.recordFailure("groq", "g", "transient", 10);
    expect(h.isAvailable("groq", "g")).toBe(false);
    expect(h.snapshot()[0]).toMatchObject({ reason: "cooldown", consecutiveFailures: COOLDOWN_AFTER_FAILURES });
    t += COOLDOWN_MS + 1;
    expect(h.isAvailable("groq", "g")).toBe(true);
    h.recordSuccess("groq", "g", 5);
    expect(h.snapshot()[0]).toMatchObject({ consecutiveFailures: 0, reason: undefined });
  });

  it("skipped (known-unavailable) targets cost no request and are reported as skipped", async () => {
    const { createHealthRegistry } = await import("@/lib/ai/health");
    const health = createHealthRegistry();
    health.recordFailure("gemini", "p", "quota", 1, 3_600_000);
    const primary = vi.fn(ok("p"));
    const r = await routeGeneration(
      [{ provider: "gemini", model: "p", retries: 2, call: primary }, { provider: "groq", model: "g", retries: 0, call: ok("g") }],
      base,
      { ...noSleep, health },
    );
    expect(primary).not.toHaveBeenCalled();
    expect(r.metadata.attempts[0]).toMatchObject({ status: "skipped" });
  });
});
