import Link from "next/link";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ImageListParams } from "@/lib/admin/validation";

/** GET form: filters live in the URL (shareable, no JS needed). */
export function ImageFilters({ status, from, to, owner }: Omit<ImageListParams, "page">) {
  return (
    <form method="get" action="/admin/storage" role="search" className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="grid gap-1.5 sm:w-48">
        <label htmlFor="img-status" className="text-sm font-semibold">Cleanup status</label>
        <Select id="img-status" name="status" defaultValue={status ?? ""}>
          <option value="">All images</option>
          <option value="eligible">Eligible for Cleanup</option>
          <option value="pending">Pending Cleanup</option>
          <option value="protected">Protected</option>
        </Select>
      </div>
      <div className="grid gap-1.5 sm:w-40">
        <label htmlFor="img-from" className="text-sm font-semibold">Uploaded from</label>
        <Input id="img-from" name="from" type="date" defaultValue={from ?? ""} />
      </div>
      <div className="grid gap-1.5 sm:w-40">
        <label htmlFor="img-to" className="text-sm font-semibold">Uploaded to</label>
        <Input id="img-to" name="to" type="date" defaultValue={to ?? ""} />
      </div>
      <div className="grid min-w-0 flex-1 gap-1.5 sm:min-w-48">
        <label htmlFor="img-owner" className="text-sm font-semibold">Owner</label>
        <Input id="img-owner" name="owner" type="search" defaultValue={owner} placeholder="Host name or email" maxLength={100} />
      </div>
      <div className="flex gap-2">
        <Button type="submit"><Search aria-hidden="true" /> Filter</Button>
        {status || from || to || owner ? <Button asChild variant="ghost"><Link href="/admin/storage">Reset</Link></Button> : null}
      </div>
    </form>
  );
}
