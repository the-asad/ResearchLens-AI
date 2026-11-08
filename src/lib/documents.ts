import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { storageBucket } from "@/lib/env.server";
import { MAX_NOTE_BYTES, MAX_PDF_BYTES } from "@/lib/validation";
import { hasPdfSignature, imageSignature } from "@/lib/pdf";
import type { Json } from "@/lib/database.types";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify an uploaded object belongs to the document and is genuinely a PDF:
 * object exists at the derived path, size matches the declared size and the limit,
 * and the first bytes contain the %PDF- signature. Uses the user-scoped client, so
 * storage RLS applies to every read.
 */
export function bucketFor(kind: "paper" | "note") {
  return kind === "note" ? "research-notes" : storageBucket();
}

export async function verifyUploadedObject(
  supabase: SupabaseServer,
  doc: { storage_path: string; file_size_bytes: number; kind?: "paper" | "note"; mime_type?: string },
): Promise<VerifyResult> {
  const kind = doc.kind ?? "paper";
  const bucket = supabase.storage.from(bucketFor(kind));

  const { data: info, error: infoError } = await bucket.info(doc.storage_path);
  if (infoError || !info) return { ok: false, reason: "Uploaded file was not found." };
  const size = typeof info.size === "number" ? info.size : undefined;
  if (size === undefined || size <= 0) return { ok: false, reason: "Uploaded file is empty." };
  if (size > (kind === "note" ? MAX_NOTE_BYTES : MAX_PDF_BYTES)) return { ok: false, reason: "File exceeds the size limit." };
  if (size !== doc.file_size_bytes) return { ok: false, reason: "Uploaded size does not match the selected file." };

  const { data: signed, error: signError } = await bucket.createSignedUrl(doc.storage_path, 60);
  if (signError || !signed) return { ok: false, reason: "Could not read the uploaded file." };

  const res = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-1023" }, cache: "no-store" });
  if (!res.ok && res.status !== 206) return { ok: false, reason: "Could not read the uploaded file." };
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 1024);
  if (kind === "paper" && !hasPdfSignature(head)) return { ok: false, reason: "File is not a valid PDF." };
  if (kind === "note" && imageSignature(head) !== doc.mime_type) return { ok: false, reason: "File is not a valid PNG, JPEG or WebP image." };

  return { ok: true };
}

/**
 * Server-owned status transition. Callers MUST have verified ownership with the user client;
 * the owner_id filter is repeated here as defence in depth because the admin client bypasses RLS.
 * Returns false (and logs only the Postgres error code) instead of throwing, so callers can
 * report a precise, user-safe failure stage.
 */
export async function setDocumentStatus(
  documentId: string,
  ownerId: string,
  patch: { status: "uploaded" | "failed"; error_message?: string | null; processing_metadata?: { [key: string]: Json | undefined } },
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("documents")
    .update(patch)
    .eq("id", documentId)
    .eq("owner_id", ownerId)
    .eq("status", "pending_upload")
    .select("id");
  if (error || !data?.length) {
    console.error(JSON.stringify({ event: "document.status_update_failed", documentId, to: patch.status, code: error?.code ?? "no_row" }));
    return false;
  }
  return true;
}

/**
 * Short-lived signed URL for a server-derived asset (e.g. a figure crop). The caller must have
 * loaded the chunk with the user's RLS client; the path must sit under that owner's document
 * prefix — the research-derived bucket has no user policies, so this is the only way in.
 */
export async function signedDerivedAssetUrl(ownerId: string, projectId: string, documentId: string, assetPath: string) {
  if (!assetPath.startsWith(`${ownerId}/${projectId}/${documentId}/derived/`) || assetPath.includes("..")) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from("research-derived").createSignedUrl(assetPath, 60);
  return error || !data ? null : data.signedUrl;
}

/** Remove every server-derived artifact of a document (Docling JSON, figure crops). Owner-prefixed. */
export async function removeDerivedAssets(ownerId: string, projectId: string, documentId: string) {
  const admin = createAdminClient();
  const prefix = `${ownerId}/${projectId}/${documentId}/derived`;
  const bucket = admin.storage.from("research-derived");
  const paths: string[] = [];
  for (const dir of [prefix, `${prefix}/figures`]) {
    const { data } = await bucket.list(dir, { limit: 1000 });
    for (const f of data ?? []) if (f.id) paths.push(`${dir}/${f.name}`);
  }
  if (paths.length) await bucket.remove(paths);
  return paths.length;
}
