import Link from "next/link";
import { FileSearch, Lock, Quote, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/logo";
import { buttonClasses } from "@/components/ui/button";

const pillars = [
  {
    icon: Quote,
    title: "Evidence-grounded answers",
    body: "Every answer is tied to the retrieved passages and pages it came from — or it says the evidence is insufficient.",
    status: "In development",
  },
  {
    icon: ShieldCheck,
    title: "Claim verification",
    body: "Check a claim against your papers and see supporting and contradicting evidence side by side.",
    status: "Planned",
  },
  {
    icon: FileSearch,
    title: "Multimodal ingestion",
    body: "Papers, tables, figures and handwritten notes parsed into a citable evidence base.",
    status: "Planned",
  },
  {
    icon: Lock,
    title: "Private by design",
    body: "Row-level security, private storage and tenant-scoped retrieval keep unpublished work yours.",
    status: "Available",
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex items-center gap-2">
          <Link href="/login" className={buttonClasses("ghost", "md")}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonClasses("primary", "md")}>
            Get started
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <section className="py-20 sm:py-28">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Research intelligence</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Read less blindly. Verify every claim against the evidence.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
            ResearchLens AI is an evidence-grounded research platform: ingest papers, ask questions with exact
            citations, compare findings and verify claims — with provenance you can inspect.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/signup" className={buttonClasses("primary", "lg")}>
              Create a private workspace
            </Link>
            <Link href="/login" className={buttonClasses("secondary", "lg")}>
              Sign in
            </Link>
          </div>
        </section>

        <section className="grid gap-4 pb-24 sm:grid-cols-2">
          {pillars.map((p) => (
            <div key={p.title} className="rounded-xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
              <div className="flex items-center justify-between">
                <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
                  <p.icon className="size-[18px]" />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">{p.status}</span>
              </div>
              <h2 className="mt-4 font-semibold tracking-tight">{p.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{p.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border py-6 text-center text-[13px] text-subtle">
        ResearchLens AI — Evidence-Grounded Multimodal Research Intelligence
      </footer>
    </div>
  );
}
