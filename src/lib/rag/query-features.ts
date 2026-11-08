/**
 * Deterministic query analysis for adaptive retrieval (no LLM call).
 * Features are cheap lexical signals that predict when exact-term matching helps:
 * code-like identifiers (snake_case, CamelCase+digits, symbols like O(n^2)), acronyms, numbers,
 * quoted phrases, and comparison / multi-paper intent.
 */
export type QueryFeatures = {
  identifiers: string[];
  acronyms: string[];
  numbers: string[];
  quoted: string[];
  comparison: boolean;
  multiPaper: boolean;
  kind: "identifier" | "numeric" | "comparison" | "semantic";
};

const STOP_ACRONYMS = new Set(["I", "A", "WHAT", "HOW", "WHY", "WHICH", "DOES", "THE", "AND", "OR", "NOT"]);

export function analyzeQuery(q: string): QueryFeatures {
  const tokens = q.match(/[A-Za-z0-9_+\-^().]+/g) ?? [];
  const identifiers = tokens.filter(
    (t) => /_/.test(t) || /[A-Za-z]\d|\d[A-Za-z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t) || /\(.*\^.*\)|O\(/.test(t) || /[A-Za-z]\+$/.test(t),
  );
  const acronyms = tokens.filter((t) => /^[A-Z]{2,}[a-z]?$/.test(t) && !STOP_ACRONYMS.has(t));
  const numbers = tokens.filter((t) => /^\d+([.,]\d+)?%?$/.test(t));
  const quoted = [...q.matchAll(/["“']([^"”']{2,60})["”']/g)].map((m) => m[1]);
  const comparison = /\b(compare|comparison|versus|vs\.?|differ|difference|agree|disagree|contradict|both|each)\b/i.test(q);
  const multiPaper = comparison || /\bwhich (papers|models|methods)\b/i.test(q);
  const kind = comparison ? "comparison" : identifiers.length + quoted.length > 0 || acronyms.length >= 2 ? "identifier" : numbers.length ? "numeric" : "semantic";
  return { identifiers, acronyms, numbers, quoted, comparison, multiPaper, kind };
}

/**
 * Fusion weights chosen a priori (before evaluation): dense dominates for semantic questions;
 * lexical gets equal weight only when the query carries exact identifiers.
 */
export function fusionWeights(f: QueryFeatures): { dense: number; lexical: number } {
  if (f.kind === "identifier") return { dense: 1, lexical: 1 };
  if (f.kind === "numeric") return { dense: 1, lexical: 0.5 };
  return { dense: 1, lexical: 0.25 };
}
