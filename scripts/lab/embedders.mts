/**
 * Embedding models under test. Every model has its own vector space; vectors are only ever
 * compared within one model. Disk cache keyed by model + role + sha1(text) avoids re-embedding.
 */
import { createHash } from "node:crypto";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { createGeminiEmbeddingProvider } from "../../src/lib/rag/embeddings";

env.cacheDir = "eval/cache/hf";

export type Embedder = {
  id: string;
  dims: number;
  maxTokens: number;
  license: string;
  sizeMB: number;
  runtime: "api" | "local-onnx";
  embed(texts: string[], role: "query" | "document"): Promise<number[][]>;
};

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

async function cached(id: string, role: string, texts: string[], compute: (t: string[]) => Promise<number[][]>) {
  await mkdir("eval/cache/emb", { recursive: true });
  const file = `eval/cache/emb/${id.replace(/[^a-z0-9.-]/gi, "_")}.jsonl`;
  const map = new Map<string, number[]>();
  try {
    for (const line of (await readFile(file, "utf8")).split("\n")) if (line) { const [k, v] = JSON.parse(line); map.set(k, v); }
  } catch { /* empty cache */ }
  const keys = texts.map((t) => sha(`${role}\u0000${t}`));
  const missing = [...new Set(keys.filter((k) => !map.has(k)))];
  if (missing.length) {
    const byKey = new Map(keys.map((k, i) => [k, texts[i]]));
    // Persist after every slice so an interrupted run (quota, crash) resumes where it stopped.
    for (let s = 0; s < missing.length; s += 50) {
      const part = missing.slice(s, s + 50);
      const vecs = await compute(part.map((k) => byKey.get(k)!));
      let lines = "";
      part.forEach((k, i) => { map.set(k, vecs[i]); lines += JSON.stringify([k, vecs[i].map((x) => Math.round(x * 1e6) / 1e6)]) + "\n"; });
      await appendFile(file, lines);
    }
  }
  return keys.map((k) => map.get(k)!);
}

function local(id: string, model: string, dims: number, opts: { pooling: "cls" | "mean"; q: string; d: string; maxTokens: number; license: string; sizeMB: number }): Embedder {
  let pipe: FeatureExtractionPipeline | undefined;
  return {
    id, dims, maxTokens: opts.maxTokens, license: opts.license, sizeMB: opts.sizeMB, runtime: "local-onnx",
    async embed(texts, role) {
      return cached(id, role, texts, async (todo) => {
        pipe ??= (await pipeline("feature-extraction", model, { dtype: "q8" })) as FeatureExtractionPipeline;
        const out: number[][] = [];
        const bs = opts.maxTokens > 512 ? 2 : 16; // long-context models: small batches bound attention memory
        for (let i = 0; i < todo.length; i += bs) {
          const batch = todo.slice(i, i + bs).map((t) => (role === "query" ? opts.q : opts.d) + t);
          const t = await pipe(batch, { pooling: opts.pooling, normalize: true });
          out.push(...(t.tolist() as number[][]));
        }
        return out;
      });
    },
  };
}

export function embedders(): Embedder[] {
  const gemini = createGeminiEmbeddingProvider(process.env.GEMINI_API_KEY!, { batchSize: 50 });
  return [
    {
      id: "gemini-embedding-2@768", dims: 768, maxTokens: 8192, license: "API (free tier)", sizeMB: 0, runtime: "api",
      embed: (texts, role) => cached("gemini-embedding-2@768", role, texts, (t) => (role === "query" ? Promise.all(t.map((x) => gemini.embedQuery(x))) : gemini.embedDocuments(t))),
    },
    local("bge-small-en-v1.5", "Xenova/bge-small-en-v1.5", 384, { pooling: "cls", q: "Represent this sentence for searching relevant passages: ", d: "", maxTokens: 512, license: "MIT", sizeMB: 34 }),
    local("bge-base-en-v1.5", "Xenova/bge-base-en-v1.5", 768, { pooling: "cls", q: "Represent this sentence for searching relevant passages: ", d: "", maxTokens: 512, license: "MIT", sizeMB: 110 }),
    local("e5-base-v2", "Xenova/e5-base-v2", 768, { pooling: "mean", q: "query: ", d: "passage: ", maxTokens: 512, license: "MIT", sizeMB: 110 }),
    local("nomic-embed-text-v1.5", "nomic-ai/nomic-embed-text-v1.5", 768, { pooling: "mean", q: "search_query: ", d: "search_document: ", maxTokens: 8192, license: "Apache-2.0", sizeMB: 137 }),
  ];
}
