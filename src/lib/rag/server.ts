import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { serverEnv, storageBucket } from "@/lib/env.server";
import type { Json } from "@/lib/database.types";
import { createGeminiEmbeddingProvider, EmbeddingError, type EmbeddingProvider } from "./embeddings";
import { ingestDocument, type IngestResult } from "./ingest";
import { ask, type AskInput, type AskResult } from "./pipeline";
import { llmGenerate, llmRerank } from "./ai";
import { supabaseRetrievalStore } from "./store-supabase";

let embedder: EmbeddingProvider | undefined;

export function getEmbedder(): EmbeddingProvider {
  if (!embedder) {
    const key = serverEnv().GEMINI_API_KEY;
    if (!key) throw new EmbeddingError("GEMINI_API_KEY is not configured", "unconfigured");
    embedder = createGeminiEmbeddingProvider(key);
  }
  return embedder;
}

/**
 * Process one document for the signed-in owner.
 * Ownership is verified with the RLS-scoped client FIRST; the service-role client is then used
 * only for the two server-owned writes (claim, chunk replacement) and always filters by the
 * verified owner id. The PDF itself is downloaded with the user's client, so storage RLS applies.
 */
export async function processDocumentForUser(userId: string, documentId: string): Promise<IngestResult> {
  const result = await processPhase1(userId, documentId);
  // Phase 2 (layout, tables, figures, OCR) runs in the document-intelligence worker. Queue it after
  // a successful text pass, and also for scanned PDFs that have no text layer (OCR needed).
  if (result.ok || result.code === "pdf_no_text") {
    const { enqueueDocIntel } = await import("./indexer");
    await enqueueDocIntel(userId, documentId).catch(() => {});
  }
  return result.ok || result.code !== "pdf_no_text"
    ? result
    : { ...result, message: "No text layer found (scanned PDF). OCR analysis has been queued; the paper becomes searchable when it completes." };
}

async function processPhase1(userId: string, documentId: string): Promise<IngestResult> {
  const supabase = await createClient();
  const { data: owned } = await supabase.from("documents").select("id, owner_id").eq("id", documentId).maybeSingle();
  if (!owned || owned.owner_id !== userId) return { ok: false, code: "not_found", message: "Document not found." };

  const admin = createAdminClient();
  return ingestDocument(
    {
      async claim() {
        const { data, error } = await admin.rpc("claim_document_for_processing", { p_document_id: documentId, p_owner_id: userId });
        if (error) throw new Error("claim failed");
        const row = Array.isArray(data) ? data[0] : null;
        return row ? { storage_path: row.storage_path, original_filename: row.original_filename } : null;
      },
      async download(path) {
        const { data, error } = await supabase.storage.from(storageBucket()).download(path);
        if (error || !data) throw new Error("download failed");
        return new Uint8Array(await data.arrayBuffer());
      },
      async writeChunks(rows, patch) {
        const { data, error } = await admin.rpc("replace_document_chunks", {
          p_document_id: documentId,
          p_owner_id: userId,
          p_chunks: rows as unknown as Json,
          p_document_patch: patch as unknown as Json,
        });
        if (error) throw new Error("chunk write failed");
        return data ?? 0;
      },
      async markFailed(message, metadata) {
        const { data: current } = await admin.from("documents").select("processing_metadata").eq("id", documentId).eq("owner_id", userId).single();
        const merged = { ...((current?.processing_metadata as Record<string, Json>) ?? {}), ...(metadata as Record<string, Json>) };
        await admin
          .from("documents")
          .update({ status: "failed", error_message: message.slice(0, 1000), processing_metadata: merged })
          .eq("id", documentId)
          .eq("owner_id", userId)
          .eq("status", "processing");
      },
      embedder: getEmbedder(),
      log: (e) => console.info(JSON.stringify(e)),
    },
    documentId,
  );
}

/** Answer a research question for the signed-in user (RLS-scoped retrieval). */
export async function askForUser(userId: string, input: AskInput): Promise<AskResult> {
  const supabase = await createClient();
  return ask(
    {
      store: supabaseRetrievalStore(supabase),
      embedder: getEmbedder(),
      rerank: llmRerank,
      rerankerId: "llm-grader-v1",
      generate: llmGenerate,
      cacheScope: userId, // caches never cross users
      log: (e) => console.info(JSON.stringify(e)),
    },
    input,
  );
}
