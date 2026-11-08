/**
 * Ingestion pipeline: private PDF → page-aware extraction → structure-aware chunks → embeddings
 * → atomic chunk replacement. Framework-free and dependency-injected so it can run inside a
 * server action today and move to a queue worker later without changes.
 */
import { CHUNKING } from "./config";
import { chunkBlocks, embeddingText, type Chunk } from "./chunker";
import { EmbeddingError, toPgVector, type EmbeddingProvider } from "./embeddings";
import { extractStructure, PdfExtractionError, readPdf } from "./pdf/extract";

export const PARSER_ID = "pdfjs(unpdf)+researchlens-layout-v1";

export type ChunkRow = {
  chunk_index: number;
  page_start: number;
  page_end: number;
  section_title: string | null;
  section_kind: string;
  content_type: "text";
  content: string;
  token_count: number;
  embedding: string;
  embedding_model: string;
  metadata: Record<string, unknown>;
};

export type IngestDeps = {
  /** Atomically claim the document (status → processing). Null if not claimable. */
  claim(): Promise<{ storage_path: string; original_filename: string } | null>;
  /** Download the original from private storage (authorised for this owner). */
  download(storagePath: string): Promise<Uint8Array>;
  /** Replace all chunks and mark ready in one transaction. Returns rows written. */
  writeChunks(rows: ChunkRow[], patch: { title: string | null; page_count: number; processing_metadata: Record<string, unknown> }): Promise<number>;
  markFailed(message: string, metadata: Record<string, unknown>): Promise<void>;
  embedder: EmbeddingProvider;
  log?: (event: Record<string, unknown>) => void;
};

export type IngestResult =
  | { ok: true; chunks: number; pages: number; title: string | null; timings: Record<string, number>; warnings: string[] }
  | { ok: false; message: string; code: string };

export async function ingestDocument(deps: IngestDeps, documentId: string): Promise<IngestResult> {
  const log = deps.log ?? (() => {});
  const timings: Record<string, number> = {};
  const t = async <T>(name: string, fn: () => Promise<T> | T) => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };

  const claimed = await deps.claim();
  if (!claimed) return { ok: false, code: "not_claimable", message: "Document is not ready for processing or is already being processed." };

  try {
    const bytes = await t("download_ms", () => deps.download(claimed.storage_path));
    const raw = await t("parse_ms", () => readPdf(bytes));
    const doc = await t("structure_ms", () => extractStructure(raw));
    const chunks: Chunk[] = await t("chunk_ms", () => chunkBlocks(doc.blocks));
    if (chunks.length === 0) throw new PdfExtractionError("No text chunks could be produced from this PDF.", "no_text");

    const title = doc.title ?? claimed.original_filename.replace(/\.pdf$/i, "");
    const inputs = chunks.map((c) => embeddingText(title, c));
    const vectors = await t("embed_ms", () => deps.embedder.embedDocuments(inputs));

    const rows: ChunkRow[] = chunks.map((c, i) => ({
      chunk_index: c.chunkIndex,
      page_start: c.pageStart,
      page_end: c.pageEnd,
      section_title: c.sectionPath.length ? c.sectionPath[c.sectionPath.length - 1] : null,
      section_kind: c.sectionKind,
      content_type: "text",
      content: c.content,
      token_count: c.tokenEstimate,
      embedding: toPgVector(vectors[i]),
      embedding_model: deps.embedder.model,
      metadata: {
        section_path: c.sectionPath,
        layout: c.layout,
        overlap_tokens: c.overlapTokens,
        ...(c.mergedParentIntro ? { merged_parent_intro: c.mergedParentIntro } : {}),
      },
    }));

    const written = await t("write_ms", () =>
      deps.writeChunks(rows, {
        title,
        page_count: doc.pageCount,
        processing_metadata: {
          ingestion: "complete",
          processed_at: new Date().toISOString(),
          parser: PARSER_ID,
          chunker: CHUNKING.VERSION,
          chunk_config: {
            target_tokens: CHUNKING.CHUNK_TARGET_TOKENS,
            max_tokens: CHUNKING.CHUNK_MAX_TOKENS,
            overlap_tokens: CHUNKING.CHUNK_OVERLAP_TOKENS,
            min_tokens: CHUNKING.CHUNK_MIN_TOKENS,
          },
          embedding_model: deps.embedder.model,
          embedding_dimensions: deps.embedder.dimensions,
          chunk_count: rows.length,
          empty_pages: doc.pages.filter((p) => p.empty).map((p) => p.pageNumber),
          warnings: doc.warnings,
          timings,
        },
      }),
    );
    log({ event: "ingest.complete", documentId, chunks: written, pages: doc.pageCount, ...timings });
    return { ok: true, chunks: written, pages: doc.pageCount, title, timings, warnings: doc.warnings };
  } catch (err) {
    const { message, code } = describeFailure(err);
    log({ event: "ingest.failed", documentId, code, ...timings });
    await deps.markFailed(message, { ingestion: "failed", failure_code: code, failed_at: new Date().toISOString(), timings }).catch(() => {});
    return { ok: false, code, message };
  }
}

/** User-safe failure messages; never include document text. */
export function describeFailure(err: unknown): { message: string; code: string } {
  if (err instanceof PdfExtractionError) return { message: err.message, code: `pdf_${err.code}` };
  if (err instanceof EmbeddingError) {
    if (err.kind === "transient") return { message: "The embedding service is temporarily unavailable. Retry processing shortly.", code: "embedding_unavailable" };
    if (err.kind === "quota") {
      const hours = err.retryAfterMs ? Math.ceil(err.retryAfterMs / 3_600_000) : null;
      return { message: `The free embedding quota is used up for today${hours ? ` (resets in about ${hours} h)` : ""}. Retry processing after it resets.`, code: "embedding_quota" };
    }
    if (err.kind === "auth" || err.kind === "unconfigured") return { message: "Embedding service is not configured correctly.", code: "embedding_config" };
    return { message: "Embedding failed for this document.", code: `embedding_${err.kind}` };
  }
  return { message: "Processing failed unexpectedly. Please retry.", code: "internal" };
}
