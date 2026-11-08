/** Retrieval evaluation metrics (pure, unit-tested). Rankings are lists of item ids, best first. */

export function recallAtK(ranking: string[], relevant: Set<string>, k: number) {
  if (relevant.size === 0) return 0;
  let hit = 0;
  for (const id of ranking.slice(0, k)) if (relevant.has(id)) hit++;
  return hit / relevant.size;
}

/** 1 if any relevant item is in the top k (a.k.a. Success@k / Hit@k). */
export function hitAtK(ranking: string[], relevant: Set<string>, k: number) {
  return ranking.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

export function reciprocalRank(ranking: string[], relevant: Set<string>) {
  const i = ranking.findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

/** Binary-relevance nDCG@k. */
export function ndcgAtK(ranking: string[], relevant: Set<string>, k: number) {
  let dcg = 0;
  ranking.slice(0, k).forEach((id, i) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function percentile(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
