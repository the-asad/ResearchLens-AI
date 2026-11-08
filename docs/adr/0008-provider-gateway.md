# ADR 0008 — Provider gateway with capabilities, health and quota awareness

**Context.** Milestone 2's evaluation exhausted Gemini's free tier (20 requests/day/model) and hit Groq's 8k tokens/min; every request then retried dead quotas several times.

**Decision.**
- A catalog (`providerCatalog()`) describes each configured model: role, capabilities (`text`, `structured`, `vision`), context, free-tier limits. Callers request a capability; vision tasks never route to text-only fallbacks. Adding a provider = one descriptor + one `call` implementation.
- A health registry tracks per-model outcomes: quota exhaustion skips the model until the provider's reset hint (capped 1 h); 3 consecutive transient failures → 30 s cooldown. Skipped attempts cost no request and are reported as `skipped`.
- Retry rules: never retry auth/invalid requests; honour short `retry-after` hints (≤ 20 s generation, ≤ 65 s embeddings); classify "per day" 429s as quota.
- Usage accounting per question (`debug.usage`): embedding calls / cache hits, reranker calls / cache hits, LLM requests, skipped attempts, fallbacks.
- The expensive LLM is used only where needed (answer generation; optional LLM grader). Embeddings are paced; query embeddings and rerank results are cached per user.

**Not added.** OpenRouter or other free aggregators: useful as an extra fallback but not required; the catalog supports adding them without code changes elsewhere. No paid providers. No "more API keys" workaround.

**Reconsider when** sustained traffic exceeds free tiers — the catalog makes a paid tier a configuration change.
