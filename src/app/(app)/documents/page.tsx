import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { ExternalLink, FileText, FolderKanban } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { uuid } from "@/lib/validation";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { StatusBadge } from "@/components/app/status-badge";
import { ConfirmSubmit } from "@/components/app/confirm-submit";
import { buttonClasses } from "@/components/ui/button";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import { deleteDocument } from "../actions";
import { Uploader } from "./uploader";
import { ProcessButton } from "./process-button";

export const metadata: Metadata = { title: "Documents" };

export default function DocumentsPage({ searchParams }: PageProps<"/documents">) {
  return (
    <>
      <PageHeader title="Documents" description="Upload research papers into a project. Files are private to your account." />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <DocumentsWorkspace searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function DocumentsWorkspace({ searchParams }: { searchParams: PageProps<"/documents">["searchParams"] }) {
  await requireUser();
  const supabase = await createClient();
  const params = await searchParams;
  const requested = typeof params.project === "string" && uuid.safeParse(params.project).success ? params.project : null;

  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name")
    .order("created_at", { ascending: false });
  if (error) return <p className="text-sm text-danger">Could not load projects.</p>;

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderKanban}
        title="Create a project first"
        description="Every paper belongs to a project so that analysis and retrieval stay scoped."
        action={
          <Link href="/projects" className={buttonClasses("primary", "sm")}>
            Create a project
          </Link>
        }
      />
    );
  }

  const active = projects.find((p) => p.id === requested) ?? projects[0];

  const { data: docs, error: docsError } = await supabase
    .from("documents")
    .select("id, original_filename, title, status, file_size_bytes, error_message, page_count, processing_metadata, created_at")
    .eq("project_id", active.id)
    .order("created_at", { ascending: false });

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Projects" className="flex gap-1 overflow-x-auto lg:flex-col">
        <p className="mb-1 hidden px-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-subtle lg:block">Projects</p>
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/documents?project=${p.id}`}
            aria-current={p.id === active.id ? "page" : undefined}
            className={cn(
              "truncate rounded-lg px-2.5 py-1.5 text-sm",
              p.id === active.id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {p.name}
          </Link>
        ))}
      </nav>

      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Upload to “{active.name}”</CardTitle>
            <CardDescription>
              Files are checked for size and a valid PDF signature, then parsed page by page, chunked by section
              and embedded for evidence retrieval. Text only — tables, figures and scans are not yet understood.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Uploader projectId={active.id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Papers</CardTitle>
          </CardHeader>
          <CardContent>
            {docsError ? (
              <p className="text-sm text-danger">Could not load documents.</p>
            ) : docs.length === 0 ? (
              <EmptyState icon={FileText} title="No papers in this project" description="Upload a PDF above to add it." />
            ) : (
              <ul className="divide-y divide-border">
                {docs.map((d) => (
                  <li key={d.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.title ?? d.original_filename}</p>
                      <p className="text-[13px] text-subtle">
                        {d.title ? `${d.original_filename} · ` : ""}
                        {formatBytes(d.file_size_bytes)} · {formatDate(d.created_at)}
                        {d.status === "ready" && d.page_count != null && ` · ${d.page_count} pages · ${chunkCount(d.processing_metadata)} chunks`}
                      </p>
                      {d.status === "failed" && d.error_message && (
                        <p className="mt-0.5 text-[13px] text-danger">{d.error_message}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <StatusBadge status={d.status} />
                      {d.status === "uploaded" && <ProcessButton documentId={d.id} label="Process" />}
                      {d.status === "failed" && isVerified(d.processing_metadata) && <ProcessButton documentId={d.id} label="Retry" />}
                      {d.status === "ready" && <ProcessButton documentId={d.id} label="Reprocess" />}
                      {(d.status === "uploaded" || d.status === "processing" || d.status === "ready") && (
                        <a
                          href={`/documents/${d.id}/file`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={buttonClasses("ghost", "sm")}
                        >
                          <ExternalLink className="size-3.5" /> View
                        </a>
                      )}
                      <form action={deleteDocument}>
                        <input type="hidden" name="id" value={d.id} />
                        <ConfirmSubmit message={`Permanently delete "${d.original_filename}" and its stored file? This cannot be undone.`} />
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function meta(m: unknown) {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
function chunkCount(m: unknown) {
  return Number(meta(m).chunk_count ?? 0);
}
function isVerified(m: unknown) {
  return typeof meta(m).verified_at === "string";
}
