export type ProviderName = "gemini" | "groq";

/** A retrieved passage. Always treated as untrusted data, never as instructions. */
export type EvidencePassage = {
  id: string; // chunk id — used for citations
  documentTitle: string;
  page?: number | null;
  section?: string | null;
  text: string;
};

export type GenerationRequest = {
  /** Task-specific instructions appended to the central security policy. */
  task: string;
  userQuery: string;
  evidence?: EvidencePassage[];
  temperature?: number;
  maxOutputTokens?: number;
};

export type StructuredRequest = GenerationRequest & {
  /** JSON Schema describing the required output object. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
};

export type ProviderAttempt = {
  provider: ProviderName;
  model: string;
  status: "ok" | "error" | "skipped";
  errorKind?: AiErrorKind;
  latencyMs: number;
};

export type GenerationMetadata = {
  requestedProvider: ProviderName;
  requestedModel: string;
  provider: ProviderName;
  model: string; // as reported by the provider when available
  fallbackUsed: boolean;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  attempts: ProviderAttempt[];
};

export type GenerationResult = { text: string; metadata: GenerationMetadata };

export type AiErrorKind =
  | "transient" // 429 / 5xx / network / timeout — retry or fall back
  | "quota" // daily/plan quota exhausted — do not retry; skip this model until it resets
  | "auth" // 401 / 403 — configuration problem, do not retry
  | "invalid_request" // 400 / 404 / 422 — do not retry the same request
  | "safety" // blocked / empty output
  | "unconfigured"
  | "unknown";

/** Low-level provider call input, after the prompt has been assembled. */
export type ProviderCall = {
  model: string;
  system: string;
  input: string;
  temperature: number;
  maxOutputTokens: number;
  json?: { schema: Record<string, unknown>; name: string };
  signal?: AbortSignal;
};

export type ProviderOutput = {
  text: string;
  model: string;
  usage?: GenerationMetadata["usage"];
};
