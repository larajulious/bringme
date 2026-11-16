import { Badge } from "@/components/ui/badge";

export type CleanupState = "protected" | "pending" | "eligible" | "failed";

const CLEANUP: Record<CleanupState, { label: string; variant: "secondary" | "yellow" | "coral" | "destructive" }> = {
  protected: { label: "Protected", variant: "secondary" },
  pending: { label: "Pending Cleanup", variant: "yellow" },
  eligible: { label: "Eligible for Cleanup", variant: "coral" },
  failed: { label: "Deletion Failed", variant: "destructive" },
};

export function CleanupStatusBadge({ status }: { status: CleanupState }) {
  const c = CLEANUP[status];
  return <Badge variant={c.variant} className="whitespace-nowrap">{c.label}</Badge>;
}

const PASS = {
  active: { label: "Active", variant: "success" },
  expired: { label: "Expired", variant: "outline" },
  none: { label: "No pass", variant: "outline" },
  unknown: { label: "Unknown", variant: "secondary" },
} as const;

export function PassStatusBadge({ status }: { status: keyof typeof PASS }) {
  const p = PASS[status];
  return <Badge variant={p.variant} className="whitespace-nowrap">{p.label}</Badge>;
}
