import { describe, expect, it } from "vitest";
import { dedupeCandidates, reciprocalRankFusion } from "@/lib/rag/retrieval";
import { assessSufficiency, selectEvidence } from "@/lib/rag/sufficiency";
import { validateCitations } from "@/lib/rag/citations";
import { hitAtK, ndcgAtK, recallAtK, reciprocalRank } from "@/lib/rag/eval-metrics";
import type { Candidate, ChunkHit, EvidencePassageOut } from "@/lib/rag/types";

const hit = (id: string, content = `content ${id} with several distinct words here`): ChunkHit => ({
  chunk_id: id, document_id: "d1", chunk_index: Number(id.replace(/\D/g, "")) || 0, page_start: 1, page_end: 1, section_title: "S", section_kind: "body", content,
});

describe("reciprocal rank fusion", () => {
  it("rewards agreement between retrievers using ranks, not raw scores", () => {
    const dense = [{ ...hit("a"), similarity: 0.9 }, { ...hit("b"), similarity: 0.8 }, { ...hit("c"), similarity: 0.7 }];
    const lexical = [{ ...hit("c"), rank: 12.5 }, { ...hit("d"), rank: 3 }];
    const fused = reciprocalRankFusion(dense, lexical, 60);
    expect(fused[0].chunk_id).toBe("c"); // 1/63 + 1/61 beats 1/61
    expect(fused.find((f) => f.chunk_id === "c")).toMatchObject({ dense: { rank: 3 }, lexical: { rank: 1 } });
    expect(fused.map((f) => f.fusedRank)).toEqual([1, 2, 3, 4]);
  });
  it("C: a lexical-only exact identifier match still enters the candidate set", () => {
    const fused = reciprocalRankFusion([], [{ ...hit("x"), rank: 1 }]);
    expect(fused.map((f) => f.chunk_id)).toEqual(["x"]);
  });
});

describe("G: duplicate / overlapping evidence", () => {
  it("removes near-duplicate chunks, keeping the higher-ranked one", () => {
    const text = "The Transformer uses eight parallel attention heads with sixty four dimensions each in the base model";
    const out = dedupeCandidates([hit("a", text), hit("b", text + " indeed"), hit("c", "completely different content about optimizers and learning rate schedules")]);
    expect(out.map((o) => o.chunk_id)).toEqual(["a", "c"]);
  });
});

describe("evidence sufficiency", () => {
  const graded = (grades: number[]) => grades.map((g, i): Candidate => ({ ...hit(`c${i}`), rrf: 1, fusedRank: i + 1, rerank: { grade: g } }));
  it("classifies by best grade", () => {
    expect(assessSufficiency(graded([1, 3, 0]))).toBe("SUFFICIENT");
    expect(assessSufficiency(graded([2, 1]))).toBe("WEAK");
    expect(assessSufficiency(graded([1, 1, 0]))).toBe("INSUFFICIENT");
    expect(assessSufficiency([])).toBe("INSUFFICIENT");
  });
  it("F: selects only passages graded ≥2, best first, so similar-but-irrelevant chunks are dropped", () => {
    expect(selectEvidence(graded([1, 2, 3, 1, 0]), 5).map((c) => c.chunk_id)).toEqual(["c2", "c1"]);
  });
});

describe("citation validation", () => {
  const ev = (id: string, doc = "d1", page: number | null = 4): EvidencePassageOut => ({
    evidenceId: id, chunkId: `chunk-${id}`, documentId: doc, documentTitle: "Attention Is All You Need", pageStart: page, pageEnd: page, section: "3.2.1 Scaled Dot-Product Attention", content: "x", role: "primary",
  });
  it("keeps supplied ids, strips fabricated ones and reports them", () => {
    const r = validateCitations("Dot-product attention is faster [E1]. It was invented in 1850 [E9]. Also [E1, E7].", [ev("E1")], new Set(["d1"]));
    expect(r.text).toBe("Dot-product attention is faster [E1]. It was invented in 1850. Also [E1].");
    expect(r.invalid.sort()).toEqual(["E7", "E9"]);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0].label).toBe("Attention Is All You Need — p. 4 — 3.2.1 Scaled Dot-Product Attention");
  });
  it("rejects citations to passages outside the authorised scope or without page metadata", () => {
    const r = validateCitations("A [E1]. B [E2].", [ev("E1", "other-doc"), ev("E2", "d1", null)], new Set(["d1"]));
    expect(r.citations).toHaveLength(0);
    expect(r.invalid.sort()).toEqual(["E1", "E2"]);
  });
});

describe("evaluation metrics", () => {
  const rel = new Set(["b", "d"]);
  it("computes recall, hit, MRR and nDCG", () => {
    expect(recallAtK(["a", "b", "c", "d"], rel, 2)).toBe(0.5);
    expect(hitAtK(["a", "b"], rel, 1)).toBe(0);
    expect(reciprocalRank(["a", "b"], rel)).toBe(0.5);
    expect(ndcgAtK(["b", "d"], rel, 10)).toBeCloseTo(1);
    expect(ndcgAtK(["a", "b"], rel, 10)).toBeCloseTo((1 / Math.log2(3)) / (1 + 1 / Math.log2(3)));
  });
});

describe("sentence-level citation validation", () => {
  const ev = (id: string): EvidencePassageOut => ({
    evidenceId: id, chunkId: `chunk-${id}`, documentId: "d1", documentTitle: "T", pageStart: 3, pageEnd: 3, section: "3.1", content: "x", role: "primary",
  });
  it("keeps supported sentences, drops uncited or fabricated-only ones, never shows uncited text", async () => {
    const { validateSentences } = await import("@/lib/rag/citations");
    const r = validateSentences(
      [
        { text: "The encoder has 6 layers.", evidenceIds: ["E1"] },
        { text: "It was trained on Mars.", evidenceIds: [] },
        { text: "It uses 9 heads.", evidenceIds: ["E7"] },
        { text: "Each layer has two sub-layers [E9].", evidenceIds: ["e1", "E1"] },
      ],
      [ev("E1")],
      new Set(["d1"]),
    );
    expect(r.text).toBe("The encoder has 6 layers. [E1] Each layer has two sub-layers. [E1]");
    expect(r.droppedSentences).toBe(2);
    expect(r.invalid).toEqual(["E7"]);
    expect(r.citations.map((c) => c.chunkId)).toEqual(["chunk-E1"]);
  });
});

describe("numeric fidelity", () => {
  const ev = (id: string, content: string): EvidencePassageOut => ({
    evidenceId: id, chunkId: `c-${id}`, documentId: "d1", documentTitle: "BERT", pageStart: 6, pageEnd: 6, section: "Table 1", content, role: "primary",
  });
  it("drops sentences whose numbers are not in the cited evidence", async () => {
    const { validateSentences, numbersIn } = await import("@/lib/rag/citations");
    expect(numbersIn("BERT-Large has 340M params, F1 of 93.2 and 1,800 steps; 15% masked in 3 ways")).toEqual(["340", "93.2", "1800", "15"]);
    const r = validateSentences(
      [
        { text: "BERTBASE reaches an MNLI accuracy of 84.6.", evidenceIds: ["E1"] },
        { text: "BERTLARGE reaches 91.7 on QNLI.", evidenceIds: ["E1"] }, // invented number
        { text: "The model has 1,800 parameters.", evidenceIds: ["E2"] },
      ],
      [ev("E1", "Row 4: System = BERTBASE | MNLI = 84.6/83.4 | QNLI = 90.5"), ev("E2", "uses 1800 parameters")],
      new Set(["d1"]),
    );
    expect(r.numericViolations).toBe(1);
    expect(r.text).toContain("84.6");
    expect(r.text).not.toContain("91.7");
    expect(r.text).toContain("1,800");
  });
});
