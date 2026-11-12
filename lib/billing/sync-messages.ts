/** Admin sync result wording (pure; unit-tested). Success wording ONLY when Polar AND BringMe! are confirmed. */
import { adminErrorMessage } from "../admin/client.ts";

export type SyncResponse =
  | { status: "synced"; environment: string; patched: boolean }
  | { status: "local_only" }
  | { status: "failed"; stage: string; error: string }
  | { status: "polar_ahead"; error: string }
  | { error: string };

const STAGE: Record<string, string> = {
  fetch: "reading the Polar product", validate: "checking the Polar product", polar_update: "updating Polar",
  verify: "verifying Polar's result", local_save: "saving in BringMe!",
};

/** Message shown after a save. Success wording ONLY when both systems are confirmed. */
export function describeSync(r: SyncResponse): { ok: boolean; text: string } {
  if ("status" in r && r.status === "synced") return { ok: true, text: `Saved and synchronized with Polar (${r.environment})${r.patched ? "" : ", which already matched"}.` };
  if ("status" in r && r.status === "local_only") return { ok: true, text: "Saved in BringMe! only: no Polar product is configured for this plan in this deployment, so it can't be bought until one is." };
  if ("status" in r && r.status === "polar_ahead") return { ok: false, text: "Polar was updated, but saving in BringMe! failed. Nothing is for sale at the new price yet. Use Retry Sync." };
  if ("status" in r && r.status === "failed") return { ok: false, text: `Not saved: synchronization failed while ${STAGE[r.stage] ?? r.stage} (${r.error}). BringMe! still has the previous values. Use Retry Sync.` };
  return { ok: false, text: adminErrorMessage("error" in r ? r.error : "update_failed") };
}

