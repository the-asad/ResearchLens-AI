import "server-only";
import { AiProviderError, classifyRateLimit, classifyStatus, parseDurationMs } from "./errors";
import type { ProviderCall, ProviderOutput } from "./types";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

type ChatResponse = {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string };
};

/** Groq OpenAI-compatible chat completions. Reasoning text is excluded from the response. */
export async function callGroq(apiKey: string, call: ProviderCall): Promise<ProviderOutput> {
  const body: Record<string, unknown> = {
    model: call.model,
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: call.input },
    ],
    temperature: call.temperature,
    max_completion_tokens: call.maxOutputTokens,
    include_reasoning: false,
  };
  if (call.json) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: call.json.name, schema: call.json.schema, strict: true },
    };
  }

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: call.signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new AiProviderError(`Groq network error: ${(err as Error).name}`, "transient", "groq");
  }

  const json = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) {
    const kind = res.status === 429 ? classifyRateLimit(json.error?.message ?? "") : classifyStatus(res.status);
    const retryAfterMs = parseDurationMs(res.headers.get("retry-after")) ?? parseDurationMs(res.headers.get("x-ratelimit-reset-tokens"));
    throw new AiProviderError(`Groq HTTP ${res.status}`, kind, "groq", res.status, retryAfterMs);
  }

  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new AiProviderError("Groq returned no text output", "safety", "groq");

  return {
    text,
    model: json.model ?? call.model,
    usage: {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  };
}
