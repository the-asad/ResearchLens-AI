/**
 * Small in-process LRU cache with TTL. Keys are SHA-256 hashes of the full scope tuple, so a
 * cached value can never be served across users, projects, models or versions.
 * Not shared between server instances (by design: no cross-instance store of private data).
 */
import { createHash } from "node:crypto";

export function scopedKey(parts: (string | number | null | undefined)[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createLruCache<V>(max = 500, ttlMs = 60 * 60 * 1000, now: () => number = () => Date.now()) {
  const map = new Map<string, { v: V; exp: number }>();
  return {
    get(key: string): V | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.exp <= now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit); // refresh recency
      return hit.v;
    },
    set(key: string, v: V) {
      if (map.has(key)) map.delete(key);
      map.set(key, { v, exp: now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value!);
    },
    get size() {
      return map.size;
    },
    clear: () => map.clear(),
  };
}

/** Normalise a query for cache lookup (case/whitespace only — never semantic rewriting). */
export function normalizeQuery(q: string) {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}
