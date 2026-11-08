import "server-only";
import { z } from "zod";
import { serverEnv } from "@/lib/env.server";
import { AiProviderError } from "./errors";
import { callGemini } from "./gemini";
import { callGroq } from "./groq";
import { buildPrompt } from "./prompts";
import { routeGeneration, type ProviderTarget } from "./router";
import { providerHealth } from "./health";
import type { GenerationRequest, GenerationResult, StructuredRequest, GenerationMetadata } from "./types";

export type { EvidencePassage, GenerationMetadata, GenerationResult } from "./types";
export { AiUnavailableError } from "./errors";

export type Capability = "text" | "structured" | "vision";

/** Static description of a configured model. Health is tracked separately (./health). */
export type ProviderDescriptor = {
  provider: "gemini" | "groq";
  model: string;
  role: "primary" | "fallback";
  capabilities: Capability[];
  contextTokens?: number;
  freeTier: boolean;
  /** Known free-tier limits (informational; enforcement comes from the provider's responses). */
  limits?: string;
};

/**
 * Configured models in priority order. Adding a provider means adding a descriptor and a
 * `call` implementation — nothing else in the codebase names providers.
 */
export function providerCatalog(): (ProviderDescriptor & { target: ProviderTarget })[] {
  const env = serverEnv();
  const out: (ProviderDescriptor & { target: ProviderTarget })[] = [];
  if (env.GEMINI_API_KEY) {
    const key = env.GEMINI_API_KEY;
    out.push({
      provider: "gemini", model: env.GEMINI_MODEL, role: "primary", capabilities: ["text", "structured", "vision"], freeTier: true,
      limits: "free tier ~20 requests/day/model (observed)",
      target: { provider: "gemini", model: env.GEMINI_MODEL, retries: 2, call: (c) => callGemini(key, c) },
    });
    if (env.GEMINI_FALLBACK_MODEL && env.GEMINI_FALLBACK_MODEL !== env.GEMINI_MODEL) {
      out.push({
        provider: "gemini", model: env.GEMINI_FALLBACK_MODEL, role: "fallback", capabilities: ["text", "structured", "vision"], freeTier: true,
        limits: "free tier ~20 requests/day/model (observed)",
        target: { provider: "gemini", model: env.GEMINI_FALLBACK_MODEL, retries: 1, call: (c) => callGemini(key, c) },
      });
    }
  }
  if (env.GROQ_API_KEY) {
    const key = env.GROQ_API_KEY;
    out.push({
      provider: "groq", model: env.GROQ_MODEL, role: "fallback", capabilities: ["text", "structured"], contextTokens: 131072, freeTier: true,
      limits: "free tier 8k tokens/min, 1k requests/day (observed headers)",
      target: { provider: "groq", model: env.GROQ_MODEL, retries: 1, call: (c) => callGroq(key, c) },
    });
  }
  return out;
}

function targets(capability: Capability = "structured"): ProviderTarget[] {
  return providerCatalog().filter((d) => d.capabilities.includes(capability)).map((d) => d.target);
}

/** Non-sensitive status for debug / evaluation views: catalog + live health. */
export function providerStatus() {
  const health = providerHealth.snapshot();
  return providerCatalog().map((d) => ({
    provider: d.provider,
    model: d.model,
    role: d.role,
    capabilities: d.capabilities,
    contextTokens: d.contextTokens,
    freeTier: d.freeTier,
    limits: d.limits,
    health: health.find((h) => h.key === `${d.provider}:${d.model}`) ?? null,
  }));
}

/** Operational metadata only — never prompts, evidence or outputs. */
function log(event: Record<string, unknown>) {
  console.info(JSON.stringify(event));
}

export async function generateResearchResponse(req: GenerationRequest): Promise<GenerationResult> {
  const { system, input } = buildPrompt(req.task, req.userQuery, req.evidence);
  const { output, metadata } = await routeGeneration(
    targets(),
    { system, input, temperature: req.temperature ?? 0.2, maxOutputTokens: req.maxOutputTokens ?? 2048 },
    { log },
  );
  return { text: output.text, metadata };
}

export async function generateStructuredResponse<T>(
  req: StructuredRequest & { parser: z.ZodType<T> },
): Promise<{ data: T; metadata: GenerationMetadata }> {
  const { system, input } = buildPrompt(req.task, req.userQuery, req.evidence);
  // Validate inside the provider call so a malformed JSON reply falls back to the next target.
  const wrap = (target: ProviderTarget): ProviderTarget => ({
    ...target,
    call: async (c) => {
      const out = await target.call(c);
      const parsed = safeJson(out.text);
      const result = req.parser.safeParse(parsed);
      if (!result.success) {
        throw new AiProviderError("Structured output failed validation", "invalid_request", target.provider);
      }
      return out;
    },
  });
  const { output, metadata } = await routeGeneration(
    targets().map(wrap),
    {
      system,
      input,
      temperature: req.temperature ?? 0,
      maxOutputTokens: req.maxOutputTokens ?? 2048,
      json: { schema: req.jsonSchema, name: req.schemaName },
    },
    { log },
  );
  return { data: req.parser.parse(safeJson(output.text)), metadata };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
