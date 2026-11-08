"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  FileText,
  MessageSquareQuote,
  GitCompareArrows,
  ShieldCheck,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Item = { label: string; href?: string; icon: LucideIcon; status?: "soon" };

const workspace: Item[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "Documents", href: "/documents", icon: FileText },
  { label: "Research Chat", href: "/chat", icon: MessageSquareQuote },
];

// Not implemented yet — rendered as non-interactive items so nothing pretends to work.
const intelligence: Item[] = [
  { label: "Compare Papers", icon: GitCompareArrows, status: "soon" },
  { label: "Verify Claim", icon: ShieldCheck, status: "soon" },
  { label: "Research Insights", icon: Lightbulb, status: "soon" },
];

const later = ["AI Reviewer", "Reproducibility", "Knowledge Graph", "Evaluation"];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-6 text-sm" aria-label="Main">
      <Section title="Workspace">
        {workspace.map((item) => {
          const active = item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`));
          return (
            <Link
              key={item.label}
              href={item.href!}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-muted hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </Section>
      <Section title="Intelligence">
        {intelligence.map((item) => (
          <div
            key={item.label}
            aria-disabled
            title="Not implemented yet"
            className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-subtle"
          >
            <item.icon className="size-4" />
            <span className="flex-1">{item.label}</span>
            <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide">Soon</span>
          </div>
        ))}
      </Section>
      <Section title="Later">
        <p className="px-2.5 text-[13px] leading-relaxed text-subtle">{later.join(" · ")}</p>
      </Section>
    </nav>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-subtle">{title}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
