import type { Metadata } from "next";

import { PageHeading } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdminPage } from "@/lib/auth/session";
import { formatMoney, parseCurrency } from "@/lib/billing/currency";
import { SOURCE_LABEL } from "@/lib/game-pass/ui";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Revenue" };

const ENV_LABEL: Record<string, string> = { production: "Production (real payments)", sandbox: "Sandbox (test data, not revenue)", unknown: "Unknown environment" };

/** Revenue per environment and currency. Amounts are never added across currencies or environments. */
export default async function RevenuePage() {
  await requireAdminPage();
  const supabase = await createClient();
  const [rev, counts] = await Promise.all([supabase.rpc("admin_revenue"), supabase.rpc("admin_pass_counts")]);
  const rows = rev.data ?? [];
  const envs = ["production", "sandbox", "unknown"].filter((e) => rows.some((r) => r.environment === e));
  const money = (minor: number, c: string) => { const cur = parseCurrency(c); return cur ? formatMoney(Number(minor), cur) : `${minor} ${c}`; };

  return (
    <>
      <PageHeading title="Revenue" description="7-Day Game Pass sales. PHP and USD are reported separately and never added together; sandbox test payments are not revenue." />
      {envs.length === 0 ? <p className="mb-8 text-muted-foreground">No orders yet.</p> : null}
      {envs.map((env) => (
        <Card key={env} className="mb-8">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <CardTitle>{ENV_LABEL[env] ?? env}</CardTitle>
            <Badge variant={env === "production" ? "success" : "yellow"}>{env}</Badge>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <caption className="sr-only">{ENV_LABEL[env]} by currency</caption>
                <thead className="bg-secondary text-secondary-foreground">
                  <tr>{["Currency", "Paid orders", "Gross sales", "Refunds", "Net sales", "Refunded orders", "Under review"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y">
                  {rows.filter((r) => r.environment === env).map((r) => (
                    <tr key={r.currency}>
                      <td className="px-4 py-3 font-semibold">{r.currency}</td>
                      <td className="px-4 py-3">{r.paid_orders}</td>
                      <td className="px-4 py-3">{money(r.gross_minor, r.currency)}</td>
                      <td className="px-4 py-3">{r.refunds_minor > 0 ? `−${money(r.refunds_minor, r.currency)}` : money(0, r.currency)}</td>
                      <td className="px-4 py-3 font-semibold">{money(r.net_minor, r.currency)}</td>
                      <td className="px-4 py-3">{r.refunded_orders}</td>
                      <td className="px-4 py-3">{r.needs_review}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Gross = amounts Polar charged on paid orders (can include tax added at checkout). Net = gross − refunds. Polar fees are not deducted.</p>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader><CardTitle>Passes by source (no money)</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <caption className="sr-only">Passes by source</caption>
            <thead className="bg-secondary text-secondary-foreground">
              <tr>{["Source", "Passes", "Active now", "Days granted"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {(counts.data ?? []).map((c) => (
                <tr key={c.source}>
                  <td className="px-4 py-3 font-semibold">{SOURCE_LABEL[c.source]}</td>
                  <td className="px-4 py-3">{c.passes}</td>
                  <td className="px-4 py-3">{c.active_now}</td>
                  <td className="px-4 py-3">{c.granted_days}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">Complimentary grants and trials are access given for free; they are not sales.</p>
        </CardContent>
      </Card>
    </>
  );
}
