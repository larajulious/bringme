/** Browser helper for admin API calls: returns an error code or null. */
export async function adminFetch(url: string, method: "POST" | "PATCH" | "PUT", body: object): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? "update_failed";
  } catch {
    return "network";
  }
}

const messages: Record<string, string> = {
  unauthenticated: "Your session has ended. Please sign in again.",
  forbidden: "You are not allowed to do that.",
  network: "Network error. Please try again.",
  unknown_plan: "That plan doesn't exist or is inactive.",
  invalid_days: "Choose between 1 and 366 days.",
  invalid_expiry: "Pick a date after the period start and within 5 years.",
  no_live_subscription: "This host has no active Game Pass.",
  paid_pass_immutable: "This is a paid Game Pass: its plan and end date can't be changed. Grant an extra pass instead.",
  reason_required: "Please give a reason (it is kept in the audit log).",
  invalid_pass: "That pass couldn't be found.",
  pass_not_revocable: "That pass has already ended or been revoked.",
  pass_not_found: "That pass couldn't be found.",
  invalid_currency: "Choose PHP or USD.",
  trial_price_must_be_zero: "The Free Trial is always free.",
  paid_price_must_be_positive: "A paid pass needs a price above zero.",
  field_not_editable: "That field can't be changed here.",
  no_subscription: "Grant a Game Pass first.",
  account_deactivated: "Reactivate the account before granting a Game Pass.",
  user_not_found: "That subscriber no longer exists.",
  cannot_change_own_account: "You can't change your own account.",
  code_taken: "That plan code is already in use.",
  plan_not_found: "That plan no longer exists.",
  use_sync_editor: "Use “Edit & sync” for this plan: its name, players and prices are kept in sync with Polar.",
  sync_in_progress: "A sync for this plan is already running. Wait a moment and refresh.",
  sync_not_installed: "Polar sync isn't installed in this database yet: apply migration 20261112000014_plan_polar_sync.sql, then try again. Nothing was changed.",
  sync_start_failed: "Couldn't start the sync. Nothing was changed. Try again.",
  job_not_retryable: "That sync can't be retried any more. Refresh the page.",
  trial_is_internal: "The Free Trial has no Polar product; edit its limits instead.",
  polar_not_configured: "Polar isn't configured for this deployment.",
  duration_fixed: "Game Passes always last 7 days.",
  invalid_code: "Code: 2–40 lowercase letters, numbers, - or _.",
  invalid_name: "Name must be 1–80 characters.",
  invalid_price: "Enter a valid price.",
  invalid_max_players: "Max players must be 2–500.",
  invalid_max_games: "Games per period must be 1–10,000 (or empty for unlimited).",
  invalid_max_active_games: "Active games must be 1–100.",
  invalid_max_rounds: "Rounds per game must be 1–200.",
  invalid_default_max_players: "Default max players must be 2–500.",
  invalid_max_photo_size: "Photo size must be 1–20 MB.",
  invalid_retention: "Retention must be 1–365 days.",
  invalid_support_email: "Enter a valid email address.",
};
export const adminErrorMessage = (code: string) => messages[code] ?? "Something went wrong. Please try again.";
