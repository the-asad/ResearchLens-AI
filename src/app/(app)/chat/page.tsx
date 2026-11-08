import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { FileText } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { ResearchChat, type ChatProject } from "./research-chat";

export const metadata: Metadata = { title: "Research Chat" };

export default function ChatPage() {
  return (
    <>
      <PageHeader
        title="Research Chat"
        description="Ask questions answered only from your processed papers. Every claim is cited to a page — or the engine abstains."
      />
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <ChatWorkspace />
      </Suspense>
    </>
  );
}

async function ChatWorkspace() {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, documents(id, title, original_filename, status, page_count)")
    .order("created_at", { ascending: false });
  if (error) return <p className="text-sm text-danger">Could not load projects.</p>;

  const projects: ChatProject[] = data
    .map((p) => ({
      id: p.id,
      name: p.name,
      documents: (p.documents ?? [])
        .filter((d) => d.status === "ready")
        .map((d) => ({ id: d.id, title: d.title ?? d.original_filename, pages: d.page_count })),
    }))
    .filter((p) => p.documents.length > 0);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No processed papers yet"
        description="Upload a PDF and process it to build an evidence base you can question."
        action={
          <Link href="/documents" className={buttonClasses("primary", "sm")}>
            Go to documents
          </Link>
        }
      />
    );
  }
  return <ResearchChat projects={projects} />;
}
