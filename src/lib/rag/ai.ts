import "server-only";
import { z } from "zod";
import { generateStructuredResponse } from "@/lib/ai";
import type { GenerationMetadata } from "@/lib/ai";
import type { GenerateFn, RerankFn, StageMeta } from "./pipeline";

function stageMeta(m: GenerationMetadata): StageMeta {
  return {
    requestedProvider: m.requestedProvider,
    requestedModel: m.requestedModel,
    provider: m.provider,
    model: m.model,
    fallbackUsed: m.fallbackUsed,
    latencyMs: m.latencyMs,
    attempts: m.attempts.map((a) => `${a.model}:${a.status}${a.errorKind ? `(${a.errorKind})` : ""}`),
  };
}

/**
 * TEMPORARY RERANKER: an LLM used as a pointwise relevance grader with structured output.
 * This is NOT a cross-encoder. It is bounded (≤ RERANK_CANDIDATES passages, each truncated),
 * its latency is measured, and it sits behind the RerankFn interface so a real cross-encoder
 * can replace it without touching the pipeline.
 */
const RERANK_TASK = `You are a relevance grader for a research retrieval system.
For EACH passage, grade how well it answers the user's question:
3 = the passage directly states the answer (or the key fact needed)
2 = the passage partially answers or provides a necessary supporting fact
1 = same topic but does not help answer this specific question
0 = irrelevant
Grade each passage independently, using only its text. Be strict: topical similarity alone is 1.
Return a grade for every passage id.`;

const rerankSchema = z.object({ grades: z.array(z.object({ id: z.string(), grade: z.number().int().min(0).max(3) })) });

export const llmRerank: RerankFn = async (query, candidates) => {
  const { data, metadata } = await generateStructuredResponse({
    task: RERANK_TASK,
    userQuery: query,
    evidence: candidates.map((c) => ({ id: c.id, documentTitle: c.title, page: c.page, section: c.section, text: c.text })),
    schemaName: "relevance_grades",
    jsonSchema: {
      type: "object",
      properties: {
        grades: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, grade: { type: "integer", minimum: 0, maximum: 3 } },
            required: ["id", "grade"],
            additionalProperties: false,
          },
        },
      },
      required: ["grades"],
      additionalProperties: false,
    },
    parser: rerankSchema,
    maxOutputTokens: 1200,
  });
  // The prompt labels passages E1..En by position; map back to the caller's ids.
  const grades: Record<string, number> = {};
  for (const g of data.grades) {
    const idx = Number(g.id.replace(/^E/, "")) - 1;
    if (Number.isInteger(idx) && candidates[idx]) grades[candidates[idx].id] = g.grade;
  }
  return { grades, meta: stageMeta(metadata) };
};

const ANSWER_TASK = `Answer the user's research question using ONLY the evidence passages.
Return the answer as a list of sentences. For EVERY sentence, list in "evidence_ids" the passage ids
(e.g. "E2") that directly support it. A sentence without supporting ids will be discarded.
Rules:
- Use only ids that appear in the evidence. Never invent ids, papers, page numbers or quotes.
- Do not use outside/general knowledge to fill gaps. If the passages do not contain the answer,
  set "answerable" to false and return an empty "sentences" list.
- If the evidence only partially answers, answer what is supported and add a sentence stating what
  is not covered (cite the passages it is based on).
- Preserve exact numbers, units, model and dataset names as written in the evidence.
- Be concise: the direct answer first, then brief supporting detail.
- When the question compares papers or asks which papers agree/disagree, address each paper
  separately (name it), cite that paper's own passages for its claims, and state explicitly when
  a paper has no evidence in the passages. Never generalise from one paper to "all papers".`;

const answerSchema = z.object({
  answerable: z.boolean(),
  sentences: z.array(z.object({ text: z.string().max(2000), evidence_ids: z.array(z.string().max(8)).max(10) })).max(30),
});

export const llmGenerate: GenerateFn = async (query, evidence, sufficiency) => {
  const { data, metadata } = await generateStructuredResponse({
    task: sufficiency === "WEAK" ? `${ANSWER_TASK}\n- The retrieved evidence was graded only partially relevant: be explicit about uncertainty.` : ANSWER_TASK,
    userQuery: query,
    evidence: evidence.map((e) => ({ id: e.evidenceId, documentTitle: e.documentTitle, page: e.pageStart, section: e.section, text: e.content })),
    schemaName: "grounded_answer",
    jsonSchema: {
      type: "object",
      properties: {
        answerable: { type: "boolean" },
        sentences: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } } },
            required: ["text", "evidence_ids"],
            additionalProperties: false,
          },
        },
      },
      required: ["answerable", "sentences"],
      additionalProperties: false,
    },
    parser: answerSchema,
    maxOutputTokens: 1500,
    temperature: 0.1,
  });
  const sentences = data.sentences.map((x) => ({ text: x.text, evidenceIds: x.evidence_ids }));
  return {
    answerable: data.answerable && sentences.some((x) => x.text.trim()),
    answer: sentences.map((x) => x.text).join(" "),
    sentences,
    meta: stageMeta(metadata),
  };
};
