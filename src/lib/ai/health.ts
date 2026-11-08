/**
 * Provider health registry (per server instance). Tracks, per provider:model, recent outcomes,
 * quota exhaustion (skip until the provider's reset hint) and short cooldowns after repeated
 * transient failures, so a dead provider is not hammered on every request. Pure; injectable clock.
 */
import type { AiErrorKind, ProviderName } from "./types";

export type HealthState = {
  key: string;
  provider: ProviderName;
  model: string;
  ok: number;
  failures: number;
  consecutiveFailures: number;
  lastErrorKind?: AiErrorKind;
  lastLatencyMs?: number;
  unavailableUntil?: number; // epoch ms
  reason?: "quota" | "cooldown";
};

export const COOLDOWN_AFTER_FAILURES = 3;
export const COOLDOWN_MS = 30_000;
export const MAX_QUOTA_SKIP_MS = 60 * 60 * 1000;

export function createHealthRegistry(now: () => number = () => Date.now()) {
  const states = new Map<string, HealthState>();
  const get = (provider: ProviderName, model: string) => {
    const key = `${provider}:${model}`;
    let s = states.get(key);
    if (!s) states.set(key, (s = { key, provider, model, ok: 0, failures: 0, consecutiveFailures: 0 }));
    return s;
  };
  return {
    isAvailable(provider: ProviderName, model: string) {
      const s = get(provider, model);
      return !s.unavailableUntil || s.unavailableUntil <= now();
    },
    recordSuccess(provider: ProviderName, model: string, latencyMs: number) {
      const s = get(provider, model);
      s.ok++;
      s.consecutiveFailures = 0;
      s.lastLatencyMs = Math.round(latencyMs);
      s.unavailableUntil = undefined;
      s.reason = undefined;
    },
    recordFailure(provider: ProviderName, model: string, kind: AiErrorKind, latencyMs: number, retryAfterMs?: number) {
      const s = get(provider, model);
      s.failures++;
      s.consecutiveFailures++;
      s.lastErrorKind = kind;
      s.lastLatencyMs = Math.round(latencyMs);
      if (kind === "quota") {
        s.unavailableUntil = now() + Math.min(retryAfterMs ?? MAX_QUOTA_SKIP_MS, MAX_QUOTA_SKIP_MS);
        s.reason = "quota";
      } else if (kind === "transient" && s.consecutiveFailures >= COOLDOWN_AFTER_FAILURES) {
        s.unavailableUntil = now() + Math.max(COOLDOWN_MS, Math.min(retryAfterMs ?? 0, MAX_QUOTA_SKIP_MS));
        s.reason = "cooldown";
      }
    },
    snapshot(): HealthState[] {
      return [...states.values()].map((s) => ({ ...s }));
    },
    reset() {
      states.clear();
    },
  };
}

export type HealthRegistry = ReturnType<typeof createHealthRegistry>;

/** Process-wide registry used by the router. */
export const providerHealth = createHealthRegistry();
