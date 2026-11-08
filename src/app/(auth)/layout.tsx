import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-1">
      <div className="flex flex-1 flex-col px-6 py-8 sm:px-12">
        <Logo />
        <main className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
      <aside className="hidden w-[44%] max-w-xl border-l border-border bg-surface lg:flex lg:flex-col lg:justify-center lg:px-14">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-accent">Evidence first</p>
        <h2 className="mt-3 text-2xl font-semibold leading-snug tracking-tight">
          Answers you can trace back to the page they came from.
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          ResearchLens keeps every paper private to your workspace and grounds analysis in the exact passages it
          retrieves — so you can verify claims instead of trusting summaries.
        </p>
        <ul className="mt-8 space-y-3 text-sm text-muted">
          {[
            "Private, per-user storage with row-level security",
            "Retrieval scoped to your own projects only",
            "Citations to the source passage and page",
          ].map((t) => (
            <li key={t} className="flex items-start gap-2.5">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
              {t}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
