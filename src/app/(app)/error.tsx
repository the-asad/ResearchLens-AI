"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-border bg-surface px-6 py-16 text-center">
      <AlertTriangle className="size-6 text-warning" />
      <h2 className="mt-3 font-semibold">Something went wrong</h2>
      <p className="mt-1 max-w-sm text-sm text-muted">The action could not be completed. No data was shared with anyone else.</p>
      <Button className="mt-5" variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
