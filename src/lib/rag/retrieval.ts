/**
 * Hybrid retrieval: dense (pgvector cosine) + lexical (PostgreSQL full-text) fused with
 * Reciprocal Rank Fusion. RRF combines RANKS, not raw scores, because cosine similarity and
 * ts_rank_cd live on incomparable scales. score(d) = Σ_r 1 / (k + rank_r(d)).
 */
import { RETRIEVAL } from "./config";
import type { Candidate, ChunkHit } from "./types";

export function reciprocalRankFusion(
  dense: (ChunkHit & { similarity: number })[],
  lexical: (ChunkHit & { rank: number })[],
  k: number = RETRIEVAL.RRF_K,
): Candidate[] {
  const byId = new Map<string, Candidate>();
  dense.forEach((hit, i) => {
    const { similarity, ...rest } = hit;
    byId.set(hit.chunk_id, { ...rest, dense: { rank: i + 1, similarity }, rrf: 1 / (k + i + 1), fusedRank: 0 });
  });
  lexical.forEach((hit, i) => {
    const { rank: score, ...rest } = hit;
    const existing = byId.get(hit.chunk_id);
    if (existing) {
      existing.lexical = { rank: i + 1, score };
      existing.rrf += 1 / (k + i + 1);
    } else byId.set(hit.chunk_id, { ...rest, lexical: { rank: i + 1, score }, rrf: 1 / (k + i + 1), fusedRank: 0 });
  });
  const fused = [...byId.values()].sort(
    (a, b) => b.rrf - a.rrf || (a.dense?.rank ?? Infinity) - (b.dense?.rank ?? Infinity) || a.chunk_index - b.chunk_index,
  );
  fused.forEach((c, i) => (c.fusedRank = i + 1));
  return fused;
}

/**
 * Remove near-duplicate candidates (e.g. overlapping chunks that repeat the same sentences),
 * keeping the better-ranked one. Jaccard similarity over word 5-gram shingles.
 */
export function dedupeCandidates<T extends { content: string }>(items: T[], threshold = 0.6): T[] {
  const shingles = (t: string) => {
    const w = t.toLowerCase().split(/\s+/).filter(Boolean);
    const s = new Set<string>();
    for (let i = 0; i + 5 <= w.length; i++) s.add(w.slice(i, i + 5).join(" "));
    if (s.size === 0) s.add(w.join(" "));
    return s;
  };
  const kept: { item: T; sh: Set<string> }[] = [];
  for (const item of items) {
    const sh = shingles(item.content);
    const dup = kept.some((k) => {
      let inter = 0;
      for (const x of sh) if (k.sh.has(x)) inter++;
      return inter / Math.min(sh.size, k.sh.size) >= threshold;
    });
    if (!dup) kept.push({ item, sh });
  }
  return kept.map((k) => k.item);
}
