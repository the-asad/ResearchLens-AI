import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import { FileUp, FolderKanban, GitCompareArrows, MessageSquareQuote, ShieldCheck, FileText } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/app/status-badge";
import { EmptyState } from "@/components/app/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="An overview of your private research workspace." />
      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>
      <QuickActions />
      <Suspense fallback={<Skeleton className="mt-8 h-56 w-full" />}>
        <RecentDocuments />
      </Suspense>
    </>
  );
}

async function Stats() {
  await requireUser();
  const supabase = await createClient();
  // All counts are RLS-scoped to the signed-in user.
  const count = (q: PromiseLike<{ count: number | null }>) => Promise.resolve(q).then((r) => r.count ?? 0);
  const docs = () => supabase.from("documents").select("id", { count: "exact", head: true });
  const [projects, documents, uploaded, ready, failed] = await Promise.all([
    count(supabase.from("projects").select("id", { count: "exact", head: true })),
    count(docs()),
    count(docs().eq("status", "uploaded")),
    count(docs().eq("status", "ready")),
    count(docs().eq("status", "failed")),
  ]);

  const stats = [
    { label: "Projects", value: projects },
    { label: "Papers", value: documents },
    { label: "Awaiting processing", value: uploaded },
    { label: "Indexed for retrieval", value: ready },
    { label: "Failed", value: failed },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s) => (
        <Card key={s.label} className="px-4 py-4">
          <p className="text-[13px] text-muted">{s.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{s.value}</p>
        </Card>
      ))}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[84px]" />
      ))}
    </div>
  );
}

function QuickActions() {
  const actions = [
    { label: "Upload research paper", href: "/documents", icon: FileUp, desc: "Add a PDF to a private project." },
    { label: "Create project", href: "/projects", icon: FolderKanban, desc: "Group papers by research topic." },
    { label: "Ask research question", href: "/chat", icon: MessageSquareQuote, desc: "Grounded answers with page citations." },
    { label: "Verify claim", icon: ShieldCheck, desc: "Not implemented yet." },
    { label: "Compare papers", icon: GitCompareArrows, desc: "Not implemented yet." },
  ];
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold">Quick actions</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {actions.map((a) => {
          const inner = (
            <>
              <a.icon className={a.href ? "size-5 text-accent" : "size-5 text-subtle"} />
              <p className={a.href ? "mt-3 text-sm font-medium" : "mt-3 text-sm font-medium text-subtle"}>{a.label}</p>
              <p className="mt-0.5 text-[13px] text-subtle">{a.desc}</p>
            </>
          );
          return a.href ? (
            <Link
              key={a.label}
              href={a.href}
              className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)] transition-colors hover:border-accent/40"
            >
              {inner}
            </Link>
          ) : (
            <div key={a.label} aria-disabled className="cursor-not-allowed rounded-xl border border-dashed border-border bg-surface/50 p-4">
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}

async function RecentDocuments() {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, original_filename, status, file_size_bytes, created_at, projects(name)")
    .order("created_at", { ascending: false })
    .limit(5);

  return (
    <Card className="mt-8">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Recent papers</CardTitle>
          <CardDescription>Your most recently uploaded documents.</CardDescription>
        </div>
        <Link href="/documents" className={buttonClasses("secondary", "sm")}>
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-danger">Could not load documents.</p>
        ) : data.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No papers yet"
            description="Upload a research paper to start building your evidence base."
            action={
              <Link href="/documents" className={buttonClasses("primary", "sm")}>
                Upload a paper
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {data.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.original_filename}</p>
                  <p className="text-[13px] text-subtle">
                    {d.projects?.name} · {formatBytes(d.file_size_bytes)} · {formatDate(d.created_at)}
                  </p>
                </div>
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
