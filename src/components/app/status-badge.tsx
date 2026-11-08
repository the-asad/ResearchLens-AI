import { Badge } from "@/components/ui/badge";
import type { DocumentStatus } from "@/lib/database.types";

const map: Record<DocumentStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  pending_upload: { label: "Awaiting upload", tone: "warning" },
  uploaded: { label: "Uploaded · not processed", tone: "neutral" },
  processing: { label: "Processing", tone: "accent" },
  ready: { label: "Indexed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const s = map[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
