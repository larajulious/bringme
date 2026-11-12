import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { parsePlanInput } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";

/** Create a Game Pass plan (audited). Prices are added per currency afterwards (plan_prices). */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { userId: adminId } = await requireSuperAdmin();
    const parsed = parsePlanInput(await readJson(request), "create");
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const v = parsed.value;

    const { data, error } = await createAdminClient()
      .from("subscription_plans")
      .insert({
        code: v.code!,
        name: v.name!,
        description: v.description ?? null,
        price_cents: v.price_cents ?? 0,
        max_players_per_game: v.max_players_per_game!,
        max_games_per_period: v.max_games_per_period ?? null,
        max_active_games: v.max_active_games!,
        max_rounds_per_game: v.max_rounds_per_game!,
        is_active: v.is_active ?? true,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") throw new HttpError(409, "code_taken");
      throw new HttpError(500, "create_failed");
    }
    await createAdminClient().rpc("admin_log", { p_admin: adminId, p_action: "plan_created", p_target: v.code!, p_details: { name: v.name!, max_players_per_game: v.max_players_per_game! } });
    return json({ id: data.id }, 201);
  });
}
