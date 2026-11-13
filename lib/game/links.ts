import type { Game } from "@/lib/supabase/database.types";

/** Each game type has its own host screen (lobby / console / results). */
export const gameHref = (g: Pick<Game, "id"> & Partial<Pick<Game, "game_type">>) =>
  g.game_type === "bingosnap" ? `/dashboard/extra-fun/bingosnap/${g.id}` : `/dashboard/games/${g.id}`;
