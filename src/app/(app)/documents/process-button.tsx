"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { processDocument } from "../actions";

export function ProcessButton({ documentId, label }: { documentId: string; label: "Process" | "Retry" | "Reprocess" }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant={label === "Process" ? "primary" : "secondary"}
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await processDocument(documentId);
            setMessage({ ok: r.ok, text: r.message });
            router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : label === "Process" ? <Cpu className="size-3.5" /> : <RotateCcw className="size-3.5" />}
        {pending ? "Processing…" : label}
      </Button>
      {message && !pending && <span className={message.ok ? "text-[12px] text-success" : "text-[12px] text-danger"}>{message.text}</span>}
    </span>
  );
}
