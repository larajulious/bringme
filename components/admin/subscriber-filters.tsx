import Link from "next/link";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SUBSCRIBER_STATES } from "@/lib/admin/validation";

/** GET form: filters live in the URL (shareable, back-button friendly, no JS needed). */
export function SubscriberFilters({ q, state }: { q: string; state: string | null }) {
  return (
    <form method="get" action="/admin/subscribers" role="search" className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="grid flex-1 gap-1.5">
        <label htmlFor="q" className="text-sm font-semibold">Search</label>
        <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name or email" maxLength={100} />
      </div>
      <div className="grid gap-1.5 sm:w-48">
        <label htmlFor="state" className="text-sm font-semibold">Status</label>
        <Select id="state" name="state" defaultValue={state ?? ""}>
          <option value="">All statuses</option>
          {SUBSCRIBER_STATES.map((s) => (
            <option key={s} value={s} className="capitalize">{s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="submit"><Search aria-hidden="true" /> Search</Button>
        {q || state ? (
          <Button asChild variant="ghost"><Link href="/admin/subscribers">Reset</Link></Button>
        ) : null}
      </div>
    </form>
  );
}
