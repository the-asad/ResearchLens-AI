import { LogOut } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { signOut } from "@/app/(auth)/actions";

export async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) return null;
  const initial = (user.email ?? "?").charAt(0).toUpperCase();
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface p-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">
        {initial}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted" title={user.email ?? undefined}>
        {user.email}
      </span>
      <form action={signOut}>
        <button
          type="submit"
          className="grid size-8 place-items-center rounded-md text-subtle hover:bg-surface-muted hover:text-foreground"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="size-4" />
        </button>
      </form>
    </div>
  );
}
