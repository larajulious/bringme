/**
 * Image Storage Cleanup: the delete run, with its database and Storage dependencies injected
 * (the route wires the real ones; tests use fakes). No eligibility is decided here: the database
 * (`admin_image_cleanup_candidates`) re-evaluates every image immediately before each Storage batch,
 * and `admin_record_image_cleanup` decides what was actually deleted.
 */

export const CLEANUP_BUCKET = "submissions";
/** Images handled per run (one click). The admin runs again for more. */
export const CLEANUP_MAX_PER_RUN = 500;
/** Images per revalidate + Storage remove() call. */
export const CLEANUP_BATCH = 100;

/** '<game>/<round>/<player>.(jpg|png|webp)', the only shape a Bring Me gameplay photo can have. */
const PHOTO_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
export const isGameplayPhotoPath = (p: string) => PHOTO_PATH.test(p);

export type Candidate = { object_name: string; bytes: number };
export type Attempt = { name: string; bytes: number; error: string | null };
export type Recorded = {
  run_id: number; deleted: number; failed: number; bytes_recovered: number; references_updated: number;
  /** DB-verified: attempted objects still present, with Storage's reason. */
  failed_items: { name: string; reason: string }[];
};

export type CleanupDeps = {
  /** Total images in the bucket right now (the "evaluated" count). */
  countImages(): Promise<number>;
  /** Eligible images, re-evaluated now. names = only these; null = oldest first. */
  candidates(names: string[] | null, limit: number): Promise<Candidate[]>;
  /** Storage API delete. Returns the names Storage reports as removed, or throws. */
  remove(paths: string[]): Promise<string[]>;
  record(evaluated: number, skipped: number, attempted: Attempt[]): Promise<Recorded>;
};

export type CleanupReport = {
  runId: number;
  evaluated: number;
  deleted: number;
  skipped: number;
  failed: number;
  bytesRecovered: number;
  referencesUpdated: number;
  failures: { name: string; reason: string }[];
  /** More eligible images may remain (this run hit its cap, or stopped early). */
  more: boolean;
  /** The run stopped early because revalidation failed; nothing unvalidated was deleted. */
  aborted: boolean;
};

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function runImageCleanup(
  deps: CleanupDeps,
  opts: { max?: number; batch?: number } = {},
): Promise<CleanupReport> {
  const max = opts.max ?? CLEANUP_MAX_PER_RUN;
  const batch = opts.batch ?? CLEANUP_BATCH;
  const evaluated = await deps.countImages();
  const initial = await deps.candidates(null, max);

  const attempted: Attempt[] = [];
  let aborted = false;
  try {
    for (const names of chunk(initial.map((c) => c.object_name), batch)) {
      // Revalidate immediately before deleting: a pass bought, a game reopened or a changed
      // owner since the preview (or since the start of this run) drops the image here.
      const fresh = (await deps.candidates(names, batch)).filter((c) => names.includes(c.object_name) && isGameplayPhotoPath(c.object_name));
      if (fresh.length === 0) continue;

      let removed: Set<string>;
      let batchError: string | null = null;
      try {
        removed = new Set(await deps.remove(fresh.map((c) => c.object_name)));
      } catch (e) {
        removed = new Set();
        batchError = e instanceof Error && /^[a-z_]{3,40}$/.test(e.message) ? e.message : "storage_error";
      }
      for (const c of fresh) {
        attempted.push({
          name: c.object_name,
          bytes: c.bytes,
          error: removed.has(c.object_name) ? null : batchError ?? "not_removed",
        });
      }
    }
  } catch {
    // A revalidation call failed mid-run: stop deleting, but still record what was already attempted.
    aborted = true;
  }

  // The database decides what is gone (object no longer in storage.objects) and writes the audit event.
  // Skipped = protected, pending, or dropped by revalidation: everything evaluated but not attempted.
  const skipped = Math.max(0, evaluated - attempted.length);
  const rec = await deps.record(evaluated, skipped, attempted);

  return {
    runId: rec.run_id,
    evaluated,
    deleted: rec.deleted,
    skipped,
    failed: rec.failed,
    bytesRecovered: rec.bytes_recovered,
    referencesUpdated: rec.references_updated,
    failures: rec.failed_items,
    more: aborted || initial.length >= max,
    aborted,
  };
}

/** Human reason an image qualifies (or doesn't). Shared by the table and the preview. */
export const REASON_LABEL: Record<string, string> = {
  eligible: "14+ days old, owner has no active pass, game has ended",
  waiting_period: "7–13 days old: waiting period",
  recent: "Under 7 days old",
  active_pass: "Owner has an active Game Pass",
  active_game: "Game is still active",
  unknown_age: "Upload date unknown",
  unverified_owner: "Owner or game couldn't be verified",
  unrecognized_path: "Not a gameplay photo",
};

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
