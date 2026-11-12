import { Badge } from "@/components/ui/badge";
import type { AccessState } from "@/lib/supabase/database.types";

const map: Record<AccessState, { label: string; variant: "success" | "yellow" | "coral" | "destructive" }> = {
  active: { label: "Active", variant: "success" },
  pending: { label: "Pending", variant: "yellow" },
  expired: { label: "Expired", variant: "coral" },
  suspended: { label: "Suspended", variant: "destructive" },
  deactivated: { label: "Deactivated", variant: "destructive" },
};

export function AccessBadge({ state }: { state: AccessState }) {
  const { label, variant } = map[state];
  return <Badge variant={variant}>{label}</Badge>;
}

/** Fixed locale/zone so server and client renders can never disagree. */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
