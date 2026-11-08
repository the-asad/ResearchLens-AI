import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { FolderKanban } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { ConfirmSubmit } from "@/components/app/confirm-submit";
import { buttonClasses } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { deleteProject } from "../actions";
import { ProjectForm } from "./project-form";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader title="Projects" description="Projects scope your papers — and, later, retrieval — to a single research question." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Suspense fallback={<Skeleton className="h-64" />}>
          <ProjectList />
        </Suspense>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>New project</CardTitle>
            <CardDescription>Only you can see projects you create.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

async function ProjectList() {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, description, created_at, documents(count)")
    .order("created_at", { ascending: false });

  if (error) return <p className="text-sm text-danger">Could not load projects.</p>;
  if (data.length === 0)
    return <EmptyState icon={FolderKanban} title="No projects yet" description="Create your first project to start uploading papers." />;

  return (
    <ul className="space-y-3">
      {data.map((p) => {
        const docCount = p.documents?.[0]?.count ?? 0;
        return (
          <li key={p.id}>
            <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">{p.name}</p>
                {p.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{p.description}</p>}
                <p className="mt-1.5 text-[13px] text-subtle">
                  {docCount} {docCount === 1 ? "paper" : "papers"} · created {formatDate(p.created_at)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link href={`/documents?project=${p.id}`} className={buttonClasses("secondary", "sm")}>
                  Open documents
                </Link>
                <form action={deleteProject}>
                  <input type="hidden" name="id" value={p.id} />
                  <ConfirmSubmit message={`Delete "${p.name}" and permanently remove its ${docCount} paper(s) and stored files? This cannot be undone.`} />
                </form>
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
