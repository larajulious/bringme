import { LocalDateTime } from "@/components/subscription/remaining-time";
import { Badge } from "@/components/ui/badge";
import { formatMoney, parseCurrency } from "@/lib/billing/currency";
import { ORDER_STATUS_LABEL, PASS_STATE_LABEL, refundLabel } from "@/lib/game-pass/ui";

export type PurchaseRow = {
  order_id: string; ordered_at: string; plan_name: string; currency: string; amount_minor: number;
  paid_amount_minor: number | null; refunded_amount_minor: number; status: string; environment: string | null;
  pass_state: string | null; activated_at: string | null; expires_at: string | null;
};

const variant = (status: string) =>
  status === "paid" ? "success" : status === "refunded" || status === "failed" ? "coral" : status === "needs_review" ? "yellow" : "secondary";

/** Purchase history (own orders for hosts; any host's for admins). Amounts shown in their own currency only. */
export function PurchaseHistory({ rows, emptyText = "No purchases yet." }: { rows: PurchaseRow[]; emptyText?: string }) {
  if (rows.length === 0) return <p className="text-muted-foreground">{emptyText}</p>;
  return (
    <div className="min-w-0 max-w-full overflow-x-auto rounded-3xl border bg-card shadow-card">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">Purchase history</caption>
        <thead className="bg-secondary text-secondary-foreground">
          <tr>
            {["Order date", "Pass", "Price", "Currency", "Payment status", "Activated", "Expires", "Refund"].map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const cur = parseCurrency(r.currency);
            const shown = r.paid_amount_minor ?? r.amount_minor;
            return (
              <tr key={r.order_id}>
                <td className="px-4 py-3"><LocalDateTime iso={r.ordered_at} /></td>
                <td className="px-4 py-3 font-semibold">
                  7-Day Game Pass · {r.plan_name}
                  {r.environment === "sandbox" ? <Badge variant="outline" className="ml-2">Test</Badge> : null}
                  {r.pass_state ? <span className="block text-xs font-normal text-muted-foreground">{PASS_STATE_LABEL[r.pass_state] ?? r.pass_state}</span> : null}
                </td>
                <td className="px-4 py-3">{cur ? formatMoney(shown, cur) : shown}</td>
                <td className="px-4 py-3">{r.currency}</td>
                <td className="px-4 py-3"><Badge variant={variant(r.status)}>{ORDER_STATUS_LABEL[r.status] ?? r.status}</Badge></td>
                <td className="px-4 py-3">{r.activated_at ? <LocalDateTime iso={r.activated_at} /> : "—"}</td>
                <td className="px-4 py-3">{r.expires_at ? <LocalDateTime iso={r.expires_at} /> : "—"}</td>
                <td className="px-4 py-3">
                  {refundLabel(r.status, r.refunded_amount_minor) ?? "—"}
                  {r.refunded_amount_minor > 0 && cur ? <span className="block text-xs text-muted-foreground">{formatMoney(r.refunded_amount_minor, cur)}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
