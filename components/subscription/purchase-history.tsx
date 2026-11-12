import { ResumeCheckoutButton } from "@/components/subscription/resume-checkout-button";
import { LocalDateTime } from "@/components/subscription/remaining-time";
import { Badge } from "@/components/ui/badge";
import { formatMoney, parseCurrency } from "@/lib/billing/currency";
import { ORDER_STATUS_LABEL, PASS_STATE_LABEL, refundLabel } from "@/lib/game-pass/ui";

export type PurchaseRow = {
  order_id: string; plan_code?: string; ordered_at: string; plan_name: string; currency: string; amount_minor: number;
  paid_amount_minor: number | null; refunded_amount_minor: number; status: string; environment: string | null;
  pass_state: string | null; activated_at: string | null; expires_at: string | null;
};

const variant = (status: string) =>
  status === "paid" ? "success" : status === "refunded" || status === "failed" ? "coral" : status === "needs_review" ? "yellow" : "secondary";

/** Purchase history (own orders for hosts; any host's for admins). Amounts shown in their own currency only. */
export function PurchaseHistory({ rows, emptyText = "No purchases yet.", resumeEnvironment = null }: {
  rows: PurchaseRow[]; emptyText?: string;
  /** Hosts only: the live Polar environment. Pending orders created in it get a "Continue checkout" button. */
  resumeEnvironment?: string | null;
}) {
  if (rows.length === 0) return <p className="rounded-3xl border border-dashed bg-card px-6 py-8 text-center text-muted-foreground">{emptyText}</p>;

  const status = (r: PurchaseRow, cur: ReturnType<typeof parseCurrency>) => (
    <>
      <Badge variant={variant(r.status)}>{ORDER_STATUS_LABEL[r.status] ?? r.status}</Badge>
      {resumeEnvironment && r.status === "pending" && r.plan_code && r.environment === resumeEnvironment && cur
        ? <ResumeCheckoutButton planCode={r.plan_code} currency={cur} />
        : resumeEnvironment !== null && r.status === "pending"
          ? <span className="mt-1 block text-xs font-normal text-muted-foreground">Started in {r.environment === "sandbox" ? "test mode" : "another environment"}. Pick the pass above to start again.</span> : null}
    </>
  );

  return (
    <>
    {/* Phones/tablets: one card per order instead of a sideways-scrolling table. */}
    <ul className="grid gap-3 md:hidden" aria-label="Purchase history">
      {rows.map((r) => {
        const cur = parseCurrency(r.currency);
        const shown = r.paid_amount_minor ?? r.amount_minor;
        const refund = refundLabel(r.status, r.refunded_amount_minor);
        return (
          <li key={r.order_id} className="rounded-3xl border bg-card p-4 shadow-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {r.plan_name}
                  {r.environment === "sandbox" ? <Badge variant="outline" className="ml-2">Test</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground"><LocalDateTime iso={r.ordered_at} /></p>
              </div>
              <p className="shrink-0 font-display text-lg font-bold text-primary">{cur ? formatMoney(shown, cur) : shown} <span className="text-xs font-semibold text-muted-foreground">{r.currency}</span></p>
            </div>
            <div className="mt-3">{status(r, cur)}</div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Activated</dt><dd>{r.activated_at ? <LocalDateTime iso={r.activated_at} /> : "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Expires</dt><dd>{r.expires_at ? <LocalDateTime iso={r.expires_at} /> : "—"}</dd></div>
              {r.pass_state ? <div><dt className="text-xs text-muted-foreground">Pass</dt><dd>{PASS_STATE_LABEL[r.pass_state] ?? r.pass_state}</dd></div> : null}
              {refund ? <div><dt className="text-xs text-muted-foreground">Refund</dt><dd>{refund}{r.refunded_amount_minor > 0 && cur ? ` · ${formatMoney(r.refunded_amount_minor, cur)}` : null}</dd></div> : null}
            </dl>
          </li>
        );
      })}
    </ul>
    <div className="hidden min-w-0 max-w-full overflow-x-auto rounded-3xl border bg-card shadow-card md:block">
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
                <td className="px-4 py-3">{status(r, cur)}</td>
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
    </>
  );
}
