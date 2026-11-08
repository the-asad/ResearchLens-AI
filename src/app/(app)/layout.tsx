import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { AppNav } from "@/components/app/nav";
import { UserMenu } from "@/components/app/user-menu";
import { Skeleton } from "@/components/ui/skeleton";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-1">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface/60 px-3 py-5 md:flex">
        <div className="px-2.5">
          <Logo href="/dashboard" />
        </div>
        <div className="mt-8 flex-1 overflow-y-auto">
          <AppNav />
        </div>
        <Suspense fallback={<Skeleton className="h-12 w-full" />}>
          <UserMenu />
        </Suspense>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
          <Logo href="/dashboard" />
        </header>
        <MobileNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}

function MobileNav() {
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border bg-surface px-4 py-2 text-sm md:hidden" aria-label="Mobile">
      {[
        ["/dashboard", "Dashboard"],
        ["/projects", "Projects"],
        ["/documents", "Documents"],
        ["/chat", "Chat"],
      ].map(([href, label]) => (
        <a key={href} href={href} className="rounded-md px-2.5 py-1 text-muted hover:bg-surface-muted hover:text-foreground">
          {label}
        </a>
      ))}
    </nav>
  );
}
