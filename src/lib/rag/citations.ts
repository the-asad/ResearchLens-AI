import type { EvidencePassageOut } from "./types";

export type ValidatedCitation = {
  evidenceId: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  section: string | null;
  label: string; // "Attention Is All You Need — p. 5 — 3.2.2 Multi-Head Attention"
};

export type CitationCheck = {
  text: string; // answer with invalid markers removed
  citations: ValidatedCitation[];
  invalid: string[]; // ids the model produced that were not supplied / not authorised
};

const MARKER = /\[(E\d{1,3}(?:\s*,\s*E\d{1,3})*)\]/g;

export function citationLabel(p: { documentTitle: string; pageStart: number; pageEnd: number; section: string | null }) {
  const pages = p.pageStart === p.pageEnd ? `p. ${p.pageStart}` : `pp. ${p.pageStart}–${p.pageEnd}`;
  return [p.documentTitle, pages, p.section].filter(Boolean).join(" — ");
}

/**
 * Programmatic citation validation. A citation survives only if its evidence id was actually
 * supplied to the model, the passage belongs to an authorised document in the current scope,
 * and it carries page metadata. Unknown ids are stripped from the text and reported.
 */
export function validateCitations(answer: string, supplied: EvidencePassageOut[], authorisedDocumentIds: Set<string>): CitationCheck {
  const byId = new Map(supplied.map((p) => [p.evidenceId, p]));
  const invalid = new Set<string>();
  const used = new Map<string, ValidatedCitation>();

  const isValid = (id: string) => {
    const p = byId.get(id);
    return Boolean(p && authorisedDocumentIds.has(p.documentId) && p.pageStart != null);
  };

  const text = answer
    .replace(MARKER, (_m, group: string) => {
      const ids = group.split(/\s*,\s*/);
      const ok = ids.filter((id) => {
        if (isValid(id)) {
          const p = byId.get(id)!;
          const pageStart = p.pageStart!;
          const pageEnd = p.pageEnd ?? pageStart;
          if (!used.has(id)) {
            used.set(id, {
              evidenceId: id,
              chunkId: p.chunkId,
              documentId: p.documentId,
              documentTitle: p.documentTitle,
              pageStart,
              pageEnd,
              section: p.section,
              label: citationLabel({ documentTitle: p.documentTitle, pageStart, pageEnd, section: p.section }),
            });
          }
          return true;
        }
        invalid.add(id);
        return false;
      });
      return ok.length ? `[${ok.join(", ")}]` : "";
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();

  return { text, citations: [...used.values()], invalid: [...invalid] };
}

export type CitedSentence = { text: string; evidenceIds: string[] };

/**
 * Sentence-level grounding (preferred): the generator returns each sentence with the evidence ids
 * that support it as structured data. A sentence is kept only if at least one of its ids is a
 * supplied, authorised, page-bearing passage; unsupported sentences are dropped (and counted),
 * never shown uncited. Inline markers the model may have written inside the text are ignored —
 * the structured ids are the source of truth.
 */
export function validateSentences(
  sentences: CitedSentence[],
  supplied: EvidencePassageOut[],
  authorisedDocumentIds: Set<string>,
): CitationCheck & { droppedSentences: number; numericViolations: number } {
  const kept: string[] = [];
  const invalid = new Set<string>();
  const citations = new Map<string, ValidatedCitation>();
  let dropped = 0;
  let numericViolations = 0;
  const byId = new Map(supplied.map((p) => [p.evidenceId, p]));
  for (const s of sentences) {
    const text = s.text.replace(MARKER, "").replace(/\s+/g, " ").replace(/ ([.,;:!?])/g, "$1").trim();
    if (!text) continue;
    const markers = [...new Set(s.evidenceIds.map((id) => id.trim().toUpperCase()))].map((id) => `[${id}]`).join(" ");
    const check = validateCitations(`${text} ${markers}`, supplied, authorisedDocumentIds);
    check.invalid.forEach((id) => invalid.add(id));
    if (check.citations.length === 0) {
      dropped++;
      continue;
    }
    // Numeric fidelity: every number stated must appear in at least one cited passage.
    const cited = check.citations.map((c) => normaliseNumbers(byId.get(c.evidenceId)?.content ?? ""));
    if (numbersIn(text).some((n) => !cited.some((c) => c.includes(n)))) {
      numericViolations++;
      dropped++;
      continue;
    }
    for (const c of check.citations) citations.set(c.evidenceId, c);
    kept.push(`${text} [${check.citations.map((c) => c.evidenceId).join(", ")}]`);
  }
  return { text: kept.join(" "), citations: [...citations.values()], invalid: [...invalid], droppedSentences: dropped, numericViolations };
}

/** "1,800" → "1800", unicode minus → "-". Applied to both answer numbers and evidence text. */
function normaliseNumbers(s: string) {
  return s.replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/[\u2212\u2013]/g, "-");
}

/** Numbers stated in a sentence (integers, decimals, percentages); ignores single digits 0–9. */
export function numbersIn(sentence: string): string[] {
  const s = normaliseNumbers(sentence);
  return [...s.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?%?(?![\w.]\d)/g)].map((m) => m[0].replace(/%$/, "")).filter((n) => n.replace("-", "").length > 1 || n.includes("."));
}
