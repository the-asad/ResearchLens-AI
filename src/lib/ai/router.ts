import { AiProviderError, AiUnavailableError } from "./errors";
import { providerHealth, type HealthRegistry } from "./health";
import type {
  GenerationMetadata,
  ProviderAttempt,
  ProviderCall,
  ProviderName,
  ProviderOutput,
} from "./types";

export type ProviderTarget = {
  provider: ProviderName;
  model: string;
  call: (input: ProviderCall) => Promise<ProviderOutput>;
  /** Extra attempts on transient errors (bounded). */
  retries: number;
};

export type RouterOptions = {
  timeoutMs?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
  health?: HealthRegistry;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Longest provider-requested wait we honour inside a single request. */
export const MAX_RETRY_AFTER_MS = 20_000;
/** Clears provider health state (tests / manual recovery). */
export function resetQuotaState() {
  providerHealth.reset();
}

/**
 * Try each target in order. Transient failures get bounded exponential backoff, then fall
 * through to the next target. Auth failures skip the provider (all of its models);
 * invalid requests skip to the next target without retry. Pure logic — unit-tested.
 */
export async function routeGeneration(
  targets: ProviderTarget[],
  base: Omit<ProviderCall, "model" | "signal">,
  opts: RouterOptions = {},
): Promise<{ output: ProviderOutput; metadata: GenerationMetadata }> {
  if (targets.length === 0) throw new AiUnavailableError([]);
  const sleep = opts.sleep ?? defaultSleep;
  const baseDelay = opts.baseDelayMs ?? 600;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const attempts: ProviderAttempt[] = [];
  const authFailed = new Set<ProviderName>();
  const started = performance.now();
  const health = opts.health ?? providerHealth;

  for (const target of targets) {
    if (authFailed.has(target.provider)) continue;
    if (!health.isAvailable(target.provider, target.model)) {
      // Known-unavailable (quota exhausted or cooling down): skip without spending a request.
      attempts.push({ provider: target.provider, model: target.model, status: "skipped", errorKind: "quota", latencyMs: 0 });
      continue;
    }
    for (let attempt = 0; attempt <= target.retries; attempt++) {
      const t0 = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const output = await target.call({ ...base, model: target.model, signal: controller.signal });
        attempts.push({ provider: target.provider, model: target.model, status: "ok", latencyMs: Math.round(performance.now() - t0) });
        const metadata: GenerationMetadata = {
          requestedProvider: targets[0].provider,
          requestedModel: targets[0].model,
          provider: target.provider,
          model: output.model,
          fallbackUsed: target !== targets[0],
          latencyMs: Math.round(performance.now() - started),
          usage: output.usage,
          attempts,
        };
        opts.log?.({ event: "ai.generation", ...metadata, attempts: attempts.length });
        return { output, metadata };
      } catch (err) {
        const e =
          err instanceof AiProviderError
            ? err
            : new AiProviderError((err as Error)?.name ?? "unknown error", "transient", target.provider);
        attempts.push({
          provider: target.provider,
          model: target.model,
          status: "error",
          errorKind: e.kind,
          latencyMs: Math.round(performance.now() - t0),
        });
        health.recordFailure(target.provider, target.model, e.kind, performance.now() - t0, e.retryAfterMs);
        opts.log?.({ event: "ai.attempt_failed", provider: target.provider, model: target.model, kind: e.kind, status: e.status });
        if (e.kind === "auth") {
          authFailed.add(target.provider);
          break;
        }
        if (e.kind === "quota" || !health.isAvailable(target.provider, target.model)) break;
        if (!e.retryable || attempt === target.retries) break;
        // Honour a short provider wait hint (e.g. Groq tokens-per-minute reset); never exceed the cap.
        const hinted = e.retryAfterMs !== undefined && e.retryAfterMs <= MAX_RETRY_AFTER_MS ? e.retryAfterMs : 0;
        await sleep(Math.max(baseDelay * 2 ** attempt, hinted));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  opts.log?.({ event: "ai.unavailable", attempts });
  throw new AiUnavailableError(attempts);
}
