/**
 * Dry-run the ingestion pipeline on a local PDF: parse → chunk → embed (real Gemini calls),
 * without touching the database. Usage: npx tsx --env-file=.env.local scripts/ingest-dry-run.mts file.pdf
 */
import { readFile } from "node:fs/promises";
import { ingestDocument } from "../src/lib/rag/ingest";
import { createGeminiEmbeddingProvider } from "../src/lib/rag/embeddings";

const file = process.argv[2];
const embedder = createGeminiEmbeddingProvider(process.env.GEMINI_API_KEY!);
let rows: { embedding: string; token_count: number; page_start: number; page_end: number }[] = [];
const result = await ingestDocument(
  {
    claim: async () => ({ storage_path: file, original_filename: file.split("/").pop()! }),
    download: async (p) => new Uint8Array(await readFile(p)),
    writeChunks: async (r) => {
      rows = r;
      return r.length;
    },
    markFailed: async (m) => console.error("FAILED:", m),
    embedder,
    log: (e) => console.log(JSON.stringify(e)),
  },
  "dry-run",
);
const dims = new Set(rows.map((r) => r.embedding.slice(1, -1).split(",").length));
console.log(JSON.stringify({ ok: result.ok, chunks: rows.length, dims: [...dims], pagesCovered: [...new Set(rows.flatMap((r) => [r.page_start, r.page_end]))].sort((a, b) => a - b) }));
