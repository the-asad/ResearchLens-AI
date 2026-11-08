import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/database.types";
import { toPgVector } from "./embeddings";
import { buildEvidenceUnits } from "./multimodal";
import type { DocIntelResult } from "./docintel";
import { getEmbedder } from "./server";
import { CHUNKING } from "./config";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Queue phase-2 document intelligence for a document (idempotent per document). Service role. */
export async function enqueueDocIntel(ownerId: string, documentId: string) {
  const admin = createAdminClient();
  const { data: open } = await admin
    .from("ingestion_jobs")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("document_id", documentId)
    .eq("kind", "docintel")
    .in("status", ["queued", "running"]);
  if (open?.length) return;
  await admin.from("ingestion_jobs").insert({ owner_id: ownerId, document_id: documentId, kind: "docintel" });
}

/**
 * Process one `index` job: Docling result → multimodal evidence units → embeddings (reusing
 * vectors for unchanged text) → atomic chunk replacement. Every query is owner-filtered and the
 * derived file path must sit under the document's own owner/project/document prefix.
 */
export async function runIndexJobOnce(workerId: string): Promise<"idle" | "done" | "failed"> {
  const admin = createAdminClient();
  const { data: jobs, error } = await admin.rpc("claim_ingestion_job", { p_worker: workerId, p_kinds: ["index"] });
  if (error) throw new Error("claim failed");
  const job = jobs?.[0];
  if (!job) return "idle";
  const ownerId = job.owner_id;
  const documentId = job.document_id;
  let claimedDoc = false;
  try {
    const { data: doc } = await admin
      .from("documents")
      .select("id, project_id, kind, title, original_filename")
      .eq("id", documentId)
      .eq("owner_id", ownerId)
      .single();
    if (!doc) throw new Error("document not found for owner");
    const path = String((job.result as { docintel?: string }).docintel ?? "");
    if (!path.startsWith(`${ownerId}/${doc.project_id}/${documentId}/derived/`)) throw new Error("derived path outside owner prefix");
    const { data: blob, error: dlError } = await admin.storage.from("research-derived").download(path);
    if (dlError || !blob) throw new Error("docintel download failed");
    const result = JSON.parse(await blob.text()) as DocIntelResult;

    const { data: claimed } = await admin.rpc("claim_document_for_processing", { p_document_id: documentId, p_owner_id: ownerId });
    if (!claimed?.length) throw new Error("document busy or not verified");
    claimedDoc = true;

    const title = doc.title ?? doc.original_filename.replace(/\.[a-z]+$/i, "");
    // Keep phase-1 (pdf.js) prose chunks for digital pages; add Docling OCR prose, tables, figures.
    const { data: phase1 } = await admin
      .from("document_chunks")
      .select("chunk_index, page_start, page_end, section_title, section_kind, content, token_count, embedding, embedding_model, metadata")
      .eq("document_id", documentId)
      .eq("owner_id", ownerId)
      .eq("derivation", "pdf_text")
      .order("chunk_index");
    const keepPhase1 = doc.kind === "paper" && (phase1?.length ?? 0) > 0;
    const { units, warnings } = buildEvidenceUnits(result, title, { kind: doc.kind, prose: keepPhase1 ? "ocr_only" : "all" });
    if (!units.length && !keepPhase1) throw new Error("no indexable content");

    // Reuse vectors for identical embedding inputs (same model) — no re-embedding on re-index.
    const embedder = getEmbedder();
    const { data: existing } = await admin
      .from("document_chunks")
      .select("embedding, embedding_model, metadata")
      .eq("document_id", documentId)
      .eq("owner_id", ownerId);
    const reuse = new Map<string, string>();
    for (const e of existing ?? []) {
      const h = (e.metadata as { embed_hash?: string } | null)?.embed_hash;
      if (h && e.embedding && e.embedding_model === embedder.model) reuse.set(h, e.embedding);
    }
    const hashes = units.map((u) => sha(`${embedder.model}\u0000${u.embedText}`));
    const missing = units.map((u, i) => ({ u, i })).filter(({ i }) => !reuse.has(hashes[i]));
    const vectors = missing.length ? await embedder.embedDocuments(missing.map(({ u }) => u.embedText)) : [];
    missing.forEach(({ i }, k) => reuse.set(hashes[i], toPgVector(vectors[k])));

    const kept = keepPhase1 ? phase1! : [];
    const keptRows = kept.map((c, i) => ({ ...c, chunk_index: i, content_type: "text", derivation: "pdf_text", embedding_modality: "text" }));
    const rows = [...keptRows, ...units.map((u, i) => ({
      chunk_index: kept.length + i, page_start: u.pageStart, page_end: u.pageEnd, section_title: u.sectionTitle,
      section_kind: u.sectionKind, content_type: u.contentType, content: u.content, token_count: u.tokenEstimate,
      embedding: reuse.get(hashes[i])!, embedding_model: embedder.model, metadata: { ...u.metadata, embed_hash: hashes[i] },
      bbox: u.bbox, structured: u.structured, derivation: u.derivation, source_asset_path: u.sourceAssetPath,
      confidence: u.confidence, embedding_modality: "text",
    }))];
    const counts = units.reduce<Record<string, number>>((m, u) => ((m[u.contentType] = (m[u.contentType] ?? 0) + 1), m), {});
    const { error: writeError } = await admin.rpc("replace_document_chunks", {
      p_document_id: documentId,
      p_owner_id: ownerId,
      p_chunks: rows as unknown as Json,
      p_document_patch: {
        title,
        page_count: result.pageCount,
        processing_metadata: {
          ingestion: "complete", parser: keepPhase1 ? "pdfjs prose + docling(tables, figures, ocr)" : "docling(layout+tables+figures+ocr)", phase: 2, processed_at: new Date().toISOString(),
          chunker: CHUNKING.VERSION, embedding_model: embedder.model, embedding_dimensions: embedder.dimensions,
          chunk_count: rows.length, unit_counts: { ...counts, text: (counts.text ?? 0) + kept.length }, embeddings_reused: units.length - missing.length + kept.length,
          ocr_pages: (result.pages ?? []).filter((p) => p.ocr).map((p) => p.page), warnings,
        },
      } as unknown as Json,
    });
    if (writeError) throw new Error("chunk write failed");
    await admin.from("ingestion_jobs").update({ status: "done", error: null }).eq("id", job.id).eq("owner_id", ownerId);
    console.info(JSON.stringify({ event: "index.done", documentId, units: rows.length, reused: units.length - missing.length, ...counts }));
    return "done";
  } catch (err) {
    const message = (err as Error).message.slice(0, 200);
    if (claimedDoc) {
      // Phase 1 chunks are untouched when phase 2 fails: return the document to its prior usable state.
      const { count } = await admin.from("document_chunks").select("id", { count: "exact", head: true }).eq("document_id", documentId).eq("owner_id", ownerId);
      await admin.from("documents").update({ status: count ? "ready" : "failed", error_message: count ? null : "Document analysis failed. Retry processing." })
        .eq("id", documentId).eq("owner_id", ownerId).eq("status", "processing");
    }
    await admin.from("ingestion_jobs").update({ status: job.attempts < 3 ? "queued" : "failed", error: message }).eq("id", job.id).eq("owner_id", ownerId);
    console.warn(JSON.stringify({ event: "index.failed", documentId, error: message }));
    return "failed";
  }
}
