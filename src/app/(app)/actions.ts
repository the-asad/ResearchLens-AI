"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { idParamSchema, projectSchema, uploadRequestSchema } from "@/lib/validation";
import { hasPdfExtension, sanitizeDisplayFilename } from "@/lib/pdf";
import { bucketFor, removeDerivedAssets, setDocumentStatus, verifyUploadedObject } from "@/lib/documents";
import { askForUser, processDocumentForUser } from "@/lib/rag/server";
import { askSchema } from "@/lib/validation";
import type { AskResult } from "@/lib/rag/pipeline";

export type ActionState = { ok: boolean; message?: string; fieldErrors?: Record<string, string[] | undefined> };

/** User-facing failure stages of the upload pipeline (no internals, paths or tokens). */
export type UploadStage = "init" | "upload" | "validation" | "processing";
export type StagedResult = { ok: true; message: string } | { ok: false; stage: UploadStage; message: string };

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireUser();
  const parsed = projectSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? undefined,
  });
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };

  const supabase = await createClient();
  // owner_id defaults to auth.uid(); RLS rejects anything else.
  const { error } = await supabase.from("projects").insert(parsed.data);
  if (error) return { ok: false, message: "Could not create the project." };

  revalidatePath("/projects");
  revalidatePath("/dashboard");
  return { ok: true, message: "Project created." };
}

export async function deleteProject(formData: FormData) {
  const user = await requireUser();
  const parsed = idParamSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return;

  const supabase = await createClient();
  // RLS limits this to the caller's own documents in the project.
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id, storage_path, kind")
    .eq("project_id", parsed.data.id);
  if (error) throw new Error("Could not load project documents");

  if (docs.length > 0) {
    for (const kind of ["paper", "note"] as const) {
      const paths = docs.filter((d) => d.kind === kind).map((d) => d.storage_path);
      if (!paths.length) continue;
      const { error: storageError } = await supabase.storage.from(bucketFor(kind)).remove(paths);
      if (storageError) throw new Error("Could not delete stored files");
    }
    for (const d of docs) await removeDerivedAssets(user.id, parsed.data.id, d.id);
    const { error: docError } = await supabase.from("documents").delete().eq("project_id", parsed.data.id);
    if (docError) throw new Error("Could not delete project documents");
  }

  const { error: projectError } = await supabase
    .from("projects")
    .delete()
    .eq("id", parsed.data.id)
    .eq("owner_id", user.id);
  if (projectError) throw new Error("Could not delete project");

  revalidatePath("/projects");
  revalidatePath("/documents");
  revalidatePath("/dashboard");
  redirect("/projects");
}

// ---------------------------------------------------------------------------
// Document upload: request → (browser uploads to signed URL) → finalize
// ---------------------------------------------------------------------------

export type UploadTicket =
  | { ok: true; documentId: string; path: string; token: string; bucket: string }
  | { ok: false; stage: "init"; message: string };

export async function requestDocumentUpload(input: {
  kind?: "paper" | "note";
  projectId: string;
  filename: string;
  size: number;
  mimeType: string;
}): Promise<UploadTicket> {
  const user = await requireUser();
  const parsed = uploadRequestSchema.safeParse({ kind: "paper", ...input });
  if (!parsed.success) return { ok: false, stage: "init", message: parsed.error.issues[0]?.message ?? "Invalid upload." };
  if (parsed.data.kind === "paper" && !hasPdfExtension(parsed.data.filename)) return { ok: false, stage: "init", message: "Only .pdf files are accepted." };

  const supabase = await createClient();

  // The composite FK (project_id, owner_id) also guarantees the project is the caller's.
  const { data: doc, error } = await supabase
    .from("documents")
    .insert({
      project_id: parsed.data.projectId,
      original_filename: sanitizeDisplayFilename(parsed.data.filename),
      file_size_bytes: parsed.data.size,
      mime_type: parsed.data.mimeType,
      kind: parsed.data.kind,
    })
    .select("id, storage_path")
    .single();
  if (error || !doc) {
    console.warn(JSON.stringify({ event: "upload.init_failed", step: "insert", code: error?.code, userId: user.id }));
    return { ok: false, stage: "init", message: "Could not register the upload in this project." };
  }

  // Path is the DB-generated storage_path — never derived from the filename.
  const { data: signed, error: signError } = await supabase.storage
    .from(bucketFor(parsed.data.kind))
    .createSignedUploadUrl(doc.storage_path, { upsert: false });
  if (signError || !signed) {
    console.warn(JSON.stringify({ event: "upload.init_failed", step: "signed_url", documentId: doc.id }));
    await supabase.from("documents").delete().eq("id", doc.id);
    return { ok: false, stage: "init", message: "Could not prepare a secure upload link." };
  }

  return { ok: true, documentId: doc.id, path: signed.path, token: signed.token, bucket: bucketFor(parsed.data.kind) };
}

export async function finalizeDocumentUpload(documentId: string): Promise<StagedResult> {
  const user = await requireUser();
  const parsed = idParamSchema.safeParse({ id: documentId });
  if (!parsed.success) return { ok: false, stage: "validation", message: "Invalid document." };

  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, owner_id, storage_path, file_size_bytes, status, kind, mime_type")
    .eq("id", parsed.data.id)
    .single();
  if (error || !doc || doc.owner_id !== user.id) return { ok: false, stage: "validation", message: "Document not found." };
  if (doc.status !== "pending_upload") return { ok: false, stage: "validation", message: "Document was already finalized." };

  const result = await verifyUploadedObject(supabase, doc);
  if (!result.ok) {
    await supabase.storage.from(bucketFor(doc.kind)).remove([doc.storage_path]);
    await setDocumentStatus(doc.id, user.id, { status: "failed", error_message: result.reason });
    console.warn(JSON.stringify({ event: "document.verify_failed", documentId: doc.id }));
    revalidatePath("/documents");
    return { ok: false, stage: "validation", message: result.reason };
  }

  const recorded = await setDocumentStatus(doc.id, user.id, {
    status: "uploaded",
    error_message: null,
    processing_metadata: { verified_at: new Date().toISOString(), signature: "pdf", ingestion: "not_started" },
  });
  if (!recorded) {
    return { ok: false, stage: "validation", message: "The PDF passed validation but its status could not be saved. Please retry." };
  }
  console.info(JSON.stringify({ event: "document.uploaded", documentId: doc.id, bytes: doc.file_size_bytes, kind: doc.kind }));
  revalidatePath("/documents");
  revalidatePath("/dashboard");
  return { ok: true, message: "Upload verified." };
}

/**
 * Called when the browser-to-storage upload fails: removes the caller's own pending row and any
 * partial object so failed attempts do not leave orphans. Only affects `pending_upload` rows.
 */
export async function abandonDocumentUpload(documentId: string): Promise<void> {
  const user = await requireUser();
  const parsed = idParamSchema.safeParse({ id: documentId });
  if (!parsed.success) return;
  const supabase = await createClient();
  const { data: doc } = await supabase.from("documents").select("id, owner_id, storage_path, status, kind").eq("id", parsed.data.id).maybeSingle();
  if (!doc || doc.owner_id !== user.id || doc.status !== "pending_upload") return;
  await supabase.storage.from(bucketFor(doc.kind)).remove([doc.storage_path]);
  await supabase.from("documents").delete().eq("id", doc.id).eq("owner_id", user.id).eq("status", "pending_upload");
  console.info(JSON.stringify({ event: "upload.abandoned", documentId: doc.id }));
  revalidatePath("/documents");
}

export async function deleteDocument(formData: FormData) {
  const user = await requireUser();
  const parsed = idParamSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return;

  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, owner_id, project_id, storage_path, kind")
    .eq("id", parsed.data.id)
    .single();
  if (error || !doc || doc.owner_id !== user.id) throw new Error("Document not found");

  // Remove the private original and every derived asset first; a missing object is not an error.
  const { error: storageError } = await supabase.storage.from(bucketFor(doc.kind)).remove([doc.storage_path]);
  if (storageError) throw new Error("Could not delete the stored file");
  await removeDerivedAssets(user.id, doc.project_id, doc.id);

  // Chunks (and future evidence rows) cascade from the document.
  const { error: deleteError } = await supabase.from("documents").delete().eq("id", doc.id).eq("owner_id", user.id);
  if (deleteError) throw new Error("Could not delete the document");

  console.info(JSON.stringify({ event: "document.deleted", documentId: doc.id }));
  revalidatePath("/documents");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// RAG: ingestion + grounded question answering
// ---------------------------------------------------------------------------

export async function processDocument(documentId: string): Promise<StagedResult> {
  const user = await requireUser();
  const parsed = idParamSchema.safeParse({ id: documentId });
  if (!parsed.success) return { ok: false, stage: "processing", message: "Invalid document." };
  const supabase = await createClient();
  const { data: owned } = await supabase.from("documents").select("id, owner_id, kind").eq("id", parsed.data.id).maybeSingle();
  if (!owned || owned.owner_id !== user.id) return { ok: false, stage: "processing", message: "Document not found." };
  if (owned.kind === "note") {
    // Notes have no text layer: they go straight to the document-intelligence worker (OCR).
    const { enqueueDocIntel } = await import("@/lib/rag/indexer");
    await enqueueDocIntel(user.id, owned.id);
    revalidatePath("/documents");
    return { ok: true, message: "Note queued for OCR analysis (requires the document-intelligence worker)." };
  }
  try {
    const result = await processDocumentForUser(user.id, parsed.data.id);
    return result.ok
      ? { ok: true, message: `Processed ${result.pages} pages into ${result.chunks} evidence chunks.` }
      : { ok: false, stage: "processing", message: result.message };
  } catch (err) {
    console.error(JSON.stringify({ event: "ingest.start_failed", documentId: parsed.data.id, error: (err as Error)?.name }));
    return { ok: false, stage: "processing", message: "Processing could not start. You can retry from the documents list." };
  } finally {
    revalidatePath("/documents");
    revalidatePath("/dashboard");
  }
}

export type AskResponse =
  | { ok: true; result: Omit<AskResult, "ranked"> }
  | { ok: false; message: string };

export async function askResearchQuestion(input: { projectId: string; documentIds?: string[]; question: string }): Promise<AskResponse> {
  const user = await requireUser();
  const parsed = askSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid question." };
  try {
    const full = await askForUser(user.id, {
      query: parsed.data.question,
      projectId: parsed.data.projectId,
      documentIds: parsed.data.documentIds?.length ? parsed.data.documentIds : null,
    });
    // `ranked` holds every candidate's full text; the client only needs the selected evidence.
    const result: Omit<AskResult, "ranked"> = {
      status: full.status,
      answer: full.answer,
      sufficiency: full.sufficiency,
      citations: full.citations,
      evidence: full.evidence,
      debug: full.debug,
    };
    return { ok: true, result };
  } catch (err) {
    console.warn(JSON.stringify({ event: "rag.ask_failed", error: (err as Error)?.name }));
    return { ok: false, message: "The research engine is temporarily unavailable. Please try again." };
  }
}
