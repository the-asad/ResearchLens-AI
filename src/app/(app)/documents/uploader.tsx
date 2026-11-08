"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { abandonDocumentUpload, finalizeDocumentUpload, processDocument, requestDocumentUpload, type UploadStage } from "../actions";
import { MAX_NOTE_BYTES, MAX_PDF_BYTES, NOTE_MIME_TYPES } from "@/lib/validation";
import { cn, formatBytes } from "@/lib/utils";

const STAGE_LABEL: Record<UploadStage, string> = {
  init: "Upload initialization failed",
  upload: "PDF upload failed",
  validation: "PDF validation failed",
  processing: "Processing could not start",
};

type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: string; filename: string }
  | { kind: "done"; message: string }
  | { kind: "warning"; message: string } // stored + verified, but processing failed (retryable)
  | { kind: "error"; stage: UploadStage; message: string };

export function Uploader({ projectId }: { projectId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [kind, setKind] = useState<"paper" | "note">("paper");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleFile(file: File) {
    const fail = (stage: UploadStage, message: string) => setPhase({ kind: "error", stage, message });

    // Client-side checks are for UX only; the server and storage policies re-validate.
    if (kind === "paper" && (file.type !== "application/pdf" || !/\.pdf$/i.test(file.name))) return fail("init", "Only PDF files are accepted.");
    if (kind === "note" && !(NOTE_MIME_TYPES as readonly string[]).includes(file.type)) return fail("init", "Notes must be PNG, JPEG or WebP images.");
    if (file.size === 0) return fail("init", "That file is empty.");
    if (file.size > (kind === "note" ? MAX_NOTE_BYTES : MAX_PDF_BYTES)) return fail("init", kind === "note" ? "Image exceeds the 15 MB limit." : "PDF exceeds the 50 MB limit.");

    try {
      // Stage 1: register the document and obtain a signed upload URL.
      setPhase({ kind: "working", step: "Preparing secure upload…", filename: file.name });
      let ticket: Awaited<ReturnType<typeof requestDocumentUpload>>;
      try {
        ticket = await requestDocumentUpload({ kind, projectId, filename: file.name, size: file.size, mimeType: file.type });
      } catch {
        return fail("init", "The server could not start the upload. Please try again.");
      }
      if (!ticket.ok) return fail("init", ticket.message);

      // Stage 2: browser → private storage (direct, via the signed URL).
      setPhase({ kind: "working", step: `Uploading ${formatBytes(file.size)}…`, filename: file.name });
      let uploadError = false;
      try {
        const { error } = await createClient()
          .storage.from(ticket.bucket)
          .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type });
        uploadError = Boolean(error);
      } catch {
        uploadError = true;
      }
      if (uploadError) {
        await abandonDocumentUpload(ticket.documentId).catch(() => {});
        router.refresh();
        return fail("upload", "The file could not be stored. Check your connection and try again.");
      }

      // Stage 3: server-side verification (size + %PDF- signature) and status → uploaded.
      setPhase({ kind: "working", step: kind === "note" ? "Verifying image…" : "Verifying PDF…", filename: file.name });
      let verified: Awaited<ReturnType<typeof finalizeDocumentUpload>>;
      try {
        verified = await finalizeDocumentUpload(ticket.documentId);
      } catch {
        router.refresh();
        return fail("validation", "The server could not verify the PDF. Please try again.");
      }
      router.refresh();
      if (!verified.ok) return fail(verified.stage, verified.message);

      // Stage 4: ingestion. A failure here does NOT undo the upload — the paper is stored and
      // verified, and processing can be retried from the list.
      setPhase({ kind: "working", step: kind === "note" ? "Queuing OCR analysis…" : "Extracting, chunking and embedding…", filename: file.name });
      let processed: Awaited<ReturnType<typeof processDocument>>;
      try {
        processed = await processDocument(ticket.documentId);
      } catch {
        processed = { ok: false, stage: "processing", message: "The processing request did not complete." };
      }
      router.refresh();
      if (!processed.ok) {
        return setPhase({ kind: "warning", message: `${file.name} was uploaded and verified, but processing failed: ${processed.message} Use “Retry” on the paper below.` });
      }
      setPhase({ kind: "done", message: `${file.name} — ${processed.message}` });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const busy = phase.kind === "working";

  return (
    <div>
      <div className="mb-3 inline-flex rounded-lg border border-border p-0.5 text-[13px]" role="group" aria-label="Upload type">
        {(["paper", "note"] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cn("rounded-md px-3 py-1", kind === k ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-foreground")}
          >
            {k === "paper" ? "Research paper (PDF)" : "Research note (photo / screenshot)"}
          </button>
        ))}
      </div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy) void handleFile(f);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-surface hover:border-accent/50",
          busy && "pointer-events-none opacity-70",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={kind === "paper" ? "application/pdf,.pdf" : "image/png,image/jpeg,image/webp"}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        {busy ? <Loader2 className="size-6 animate-spin text-accent" /> : <FileUp className="size-6 text-accent" />}
        <p className="mt-3 text-sm font-medium">{busy ? phase.step : kind === "paper" ? "Drop a PDF here or click to browse" : "Drop a photo of your notes or a screenshot"}</p>
        <p className="mt-1 text-[13px] text-subtle">
          {busy ? phase.filename : kind === "paper" ? "PDF only · up to 50 MB · stored privately in your workspace" : "PNG, JPEG or WebP · up to 15 MB · handwriting recognition is imperfect"}
        </p>
      </label>
      <div aria-live="polite" className="mt-3 min-h-5 text-sm">
        {phase.kind === "done" && (
          <p className="flex items-center gap-1.5 text-success">
            <CheckCircle2 className="size-4 shrink-0" /> {phase.message}
          </p>
        )}
        {phase.kind === "warning" && (
          <p className="flex items-start gap-1.5 text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {phase.message}
          </p>
        )}
        {phase.kind === "error" && (
          <p className="flex items-start gap-1.5 text-danger">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-medium">{STAGE_LABEL[phase.stage]}.</span> {phase.message}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
