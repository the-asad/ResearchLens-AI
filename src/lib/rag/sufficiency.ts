import type { Candidate, Sufficiency } from "./types";

/**
 * Relevance grades produced by the reranker:
 *   3 = directly states the answer   2 = partially answers / necessary supporting fact
 *   1 = same topic, does not answer  0 = irrelevant
 */
export const GRADE_THRESHOLD = 2;

/** Evidence sufficiency from graded candidates — deterministic, auditable rule. */
export function assessSufficiency(graded: Candidate[]): Sufficiency {
  const best = Math.max(-1, ...graded.map((c) => c.rerank?.grade ?? -1));
  if (best >= 3) return "SUFFICIENT";
  if (best >= GRADE_THRESHOLD) return "WEAK";
  return "INSUFFICIENT";
}

/** Keep passages graded ≥ threshold, best grade first, ties broken by fused rank. */
export function selectEvidence(graded: Candidate[], finalK: number): Candidate[] {
  return graded
    .filter((c) => (c.rerank?.grade ?? 0) >= GRADE_THRESHOLD)
    .sort((a, b) => (b.rerank!.grade - a.rerank!.grade) || a.fusedRank - b.fusedRank)
    .slice(0, finalK);
}

/**
 * Cross-paper selection: round-robin over documents (each ordered by grade, then fused rank) so a
 * comparison is not answered from one paper's passages. Only passages graded ≥ threshold.
 */
export function selectEvidenceDiverse(graded: Candidate[], finalK: number): Candidate[] {
  const byDoc = new Map<string, Candidate[]>();
  for (const c of graded.filter((x) => (x.rerank?.grade ?? 0) >= GRADE_THRESHOLD).sort((a, b) => b.rerank!.grade - a.rerank!.grade || a.fusedRank - b.fusedRank)) {
    (byDoc.get(c.document_id) ?? byDoc.set(c.document_id, []).get(c.document_id)!).push(c);
  }
  const queues = [...byDoc.values()].sort((a, b) => b[0].rerank!.grade - a[0].rerank!.grade || a[0].fusedRank - b[0].fusedRank);
  const out: Candidate[] = [];
  while (out.length < finalK && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < finalK) out.push(q.shift()!);
  return out;
}

/** Comparison questions need relevant evidence from ≥ 2 documents to be SUFFICIENT. */
export function assessCrossPaperSufficiency(graded: Candidate[]): { sufficiency: Sufficiency; documents: number } {
  const docs = new Set(graded.filter((c) => (c.rerank?.grade ?? 0) >= GRADE_THRESHOLD).map((c) => c.document_id));
  const base = assessSufficiency(graded);
  if (base === "INSUFFICIENT") return { sufficiency: base, documents: docs.size };
  return { sufficiency: docs.size >= 2 ? base : "WEAK", documents: docs.size };
}
