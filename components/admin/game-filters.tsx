import Link from "next/link";
import { Search } from "lucide-react";

import { GAME_TYPE_LABEL } from "@/components/admin/game-badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { GAME_STATUSES, GAME_TYPES, type GameListParams } from "@/lib/admin/validation";

/** GET form: filters live in the URL (shareable, back-button friendly, no JS needed). */
export function GameFilters({ q, status, type, owner }: Omit<GameListParams, "page">) {
  return (
    <form method="get" action="/admin/games" role="search" className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      {owner ? <input type="hidden" name="owner" value={owner} /> : null}
      <div className="grid min-w-0 flex-1 gap-1.5 sm:min-w-56">
        <label htmlFor="q" className="text-sm font-semibold">Search</label>
        <Input id="q" name="q" type="search" defaultValue={q} placeholder="Title, room code, host name or email" maxLength={100} />
      </div>
      <div className="grid gap-1.5 sm:w-40">
        <label htmlFor="status" className="text-sm font-semibold">Status</label>
        <Select id="status" name="status" defaultValue={status ?? ""}>
          <option value="">All statuses</option>
          {GAME_STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </Select>
      </div>
      <div className="grid gap-1.5 sm:w-40">
        <label htmlFor="type" className="text-sm font-semibold">Game</label>
        <Select id="type" name="type" defaultValue={type ?? ""}>
          <option value="">All games</option>
          {GAME_TYPES.map((t) => <option key={t} value={t}>{GAME_TYPE_LABEL[t]}</option>)}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="submit"><Search aria-hidden="true" /> Search</Button>
        {q || status || type || owner ? <Button asChild variant="ghost"><Link href="/admin/games">Reset</Link></Button> : null}
      </div>
    </form>
  );
}
