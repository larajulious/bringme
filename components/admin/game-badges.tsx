import { Badge } from "@/components/ui/badge";
import type { GameStatus, GameType } from "@/lib/supabase/database.types";

export const GAME_TYPE_LABEL: Record<GameType, string> = { bring_me: "Bring Me", bingosnap: "BingoSnap" };

const STATUS: Record<GameStatus, { label: string; variant: "secondary" | "yellow" | "success" | "default" | "coral" }> = {
  draft: { label: "Draft", variant: "secondary" },
  lobby: { label: "Lobby", variant: "yellow" },
  live: { label: "Live", variant: "success" },
  finished: { label: "Finished", variant: "default" },
  canceled: { label: "Canceled", variant: "coral" },
};

export function GameStatusBadge({ status }: { status: GameStatus }) {
  const s = STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export const formatDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
