import "server-only";
import { AiProviderError, classifyRateLimit, classifyStatus, parseDurationMs } from "./errors";
import type { ProviderCall, ProviderOutput } from "./types";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

type InteractionResponse = {
  status?: string;
  model?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
};

/** Gemini Interactions API (POST /v1beta/interactions). Requests are not stored (store: false). */
export async function callGemini(apiKey: string, call: ProviderCall): Promise<ProviderOutput> {
  const body: Record<string, unknown> = {
    model: call.model,
    input: call.input,
    system_instruction: call.system,
    store: false,
    generation_config: {
      temperature: call.temperature,
      max_output_tokens: call.maxOutputTokens,
      thinking_level: "low",
    },
  };
  if (call.json) {
    body.response_mime_type = "application/json";
    body.response_format = call.json.schema;
  }

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: call.signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new AiProviderError(`Gemini network error: ${(err as Error).name}`, "transient", "gemini");
  }

  const json = (await res.json().catch(() => ({}))) as InteractionResponse;
  if (!res.ok) {
    const code = json.error?.code ?? "";
    const message = json.error?.message ?? "";
    const kind = res.status === 429 ? classifyRateLimit(message) : classifyStatus(res.status);
    const retryAfterMs = parseDurationMs(res.headers.get("retry-after")) ?? parseDurationMs(/retry in ([\dhms.]+)/i.exec(message)?.[1]);
    throw new AiProviderError(`Gemini HTTP ${res.status}${code ? ` (${code})` : ""}`, kind, "gemini", res.status, retryAfterMs);
  }

  // Only model_output steps are returned; "thought" steps (hidden reasoning) are discarded.
  const text = (json.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");

  if (json.status && json.status !== "completed") {
    throw new AiProviderError(`Gemini interaction status: ${json.status}`, json.status === "failed" ? "transient" : "safety", "gemini");
  }
  if (!text.trim()) throw new AiProviderError("Gemini returned no text output", "safety", "gemini");

  return {
    text,
    model: json.model ?? call.model,
    usage: {
      inputTokens: json.usage?.total_input_tokens,
      outputTokens: json.usage?.total_output_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  };
}
