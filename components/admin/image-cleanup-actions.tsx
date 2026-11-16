"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Eye, Trash2 } from "lucide-react";

import { CleanupStatusBadge, PassStatusBadge } from "@/components/admin/image-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/loading";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage } from "@/lib/admin/client";
import { formatBytes } from "@/lib/admin/image-cleanup";

type PreviewItem = {
  name: string; bytes: number; uploadedAt: string; ageDays: number | null;
  gameId: string | null; gameTitle: string | null; gameStatus: string | null;
  owner: string | null; passStatus: "active" | "expired" | "none" | "unknown"; passEndsAt: string | null;
};
type Preview = { evaluated: number; eligibleCount: number; eligibleBytes: number; perRun: number; items: PreviewItem[] };
type Report = {
  evaluated: number; deleted: number; skipped: number; failed: number; bytesRecovered: number;
  failures: { name: string; reason: string }[]; more: boolean; aborted: boolean;
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const REASON: Record<string, string> = {
  storage_error: "Storage couldn't delete it",
  not_removed: "Storage didn't remove it",
};

/** Why an eligible image qualifies, in words. */
function why(i: PreviewItem) {
  const pass = i.passStatus === "none" ? "owner never had a Game Pass"
    : i.passEndsAt ? `owner's last pass ended ${day(i.passEndsAt)}` : "owner has no active pass";
  return `${i.ageDays ?? "?"} days old · ${pass} · game ${i.gameStatus ?? "ended"}`;
}

async function call<T>(url: string, init?: RequestInit): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { data: body, error: null } : { data: null, error: body.error ?? "update_failed" };
  } catch {
    return { data: null, error: "network" };
  }
}

/** Preview Cleanup (read-only) and Delete Eligible Images (confirmed, server-revalidated, audited). */
export function ImageCleanupActions({ eligibleCount, eligibleBytes }: { eligibleCount: number; eligibleBytes: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const confirmId = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"preview" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const count = preview?.eligibleCount ?? eligibleCount;
  const bytes = preview?.eligibleBytes ?? eligibleBytes;
  const perRun = preview?.perRun ?? 500;

  const runPreview = async () => {
    setBusy("preview"); setError(null); setReport(null);
    const { data, error: err } = await call<Preview>("/api/admin/storage/images/preview");
    setBusy(null);
    if (err || !data) return setError(adminErrorMessage(err ?? "preview_failed"));
    setPreview(data);
  };

  const runDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!understood) return;
    setBusy("delete"); setError(null);
    const { data, error: err } = await call<Report>("/api/admin/storage/images/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "delete_permanently" }),
    });
    setBusy(null);
    setOpen(false);
    setPreview(null);
    if (err || !data) {
      setError(err === "cleanup_record_failed"
        ? "Some images may have been deleted, but the run couldn't be recorded. Run the cleanup again: it is safe to repeat."
        : adminErrorMessage(err ?? "cleanup_failed"));
      return router.refresh();
    }
    setReport(data);
    toast(`${data.deleted.toLocaleString("en-US")} ${data.deleted === 1 ? "image" : "images"} deleted`, data.failed ? "error" : "success");
    router.refresh();
  };

  return (
    <section aria-labelledby="cleanup-actions" className="mb-6 rounded-3xl border bg-card p-4 shadow-card sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="cleanup-actions" className="font-display text-lg font-bold">Cleanup</h2>
          <p className="text-sm text-muted-foreground">
            Nothing is deleted automatically. Preview first; deletion re-checks every image on the server.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={runPreview} disabled={busy !== null}>
            {busy === "preview" ? <Spinner /> : <Eye aria-hidden="true" />} Preview cleanup
          </Button>
          <Button variant="destructive" disabled={busy !== null || count === 0}
            onClick={() => { setUnderstood(false); setError(null); setOpen(true); }}>
            <Trash2 aria-hidden="true" /> Delete eligible images
          </Button>
        </div>
      </div>

      {error ? <p role="alert" className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}

      {preview ? (
        <div className="mt-5" aria-live="polite">
          <p className="text-sm">
            <strong className="tabular-nums">{preview.eligibleCount.toLocaleString("en-US")}</strong> of{" "}
            <span className="tabular-nums">{preview.evaluated.toLocaleString("en-US")}</span> images are eligible, freeing about{" "}
            <strong>{formatBytes(preview.eligibleBytes)}</strong>. Nothing has been deleted.
            {preview.eligibleCount > preview.perRun ? ` One run deletes up to ${preview.perRun}; run it again for the rest.` : ""}
          </p>
          {preview.items.length ? (
            <ul className="mt-3 max-h-80 divide-y overflow-y-auto rounded-2xl border text-sm" aria-label="Images that would be deleted">
              {preview.items.map((i) => (
                <li key={i.name} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{i.gameTitle ?? "Unknown game"} <span className="font-normal text-muted-foreground">· {i.owner ?? "Unknown owner"}</span></p>
                    <p className="text-muted-foreground">{why(i)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <PassStatusBadge status={i.passStatus} />
                    <span className="tabular-nums text-muted-foreground">{formatBytes(i.bytes)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {report ? (
        <div className="mt-5" aria-live="polite">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ["Deleted", report.deleted.toLocaleString("en-US")],
              ["Skipped / protected", report.skipped.toLocaleString("en-US")],
              ["Failed", report.failed.toLocaleString("en-US")],
              ["Space recovered", formatBytes(report.bytesRecovered)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-secondary px-4 py-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-display text-xl font-bold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {report.aborted ? (
            <p className="mt-3 text-sm font-semibold text-destructive">The run stopped early because the server couldn&apos;t re-check images. Nothing unchecked was deleted. Try again.</p>
          ) : report.more ? (
            <p className="mt-3 text-sm text-muted-foreground">More eligible images may remain. Run the cleanup again to continue.</p>
          ) : null}
          {report.failures.length ? (
            <ul className="mt-3 max-h-60 divide-y overflow-y-auto rounded-2xl border text-sm" aria-label="Images that failed to delete">
              {report.failures.map((f) => (
                <li key={f.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate font-mono text-xs" title={f.name}>{f.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-muted-foreground sm:inline">{REASON[f.reason] ?? f.reason}</span>
                    <CleanupStatusBadge status="failed" />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Modal open={open} onClose={() => busy === null && setOpen(false)} title="Delete eligible images permanently?" className="max-w-md"
        description={`Up to ${Math.min(count, perRun).toLocaleString("en-US")} images (about ${formatBytes(bytes)} in total) will be removed from storage. This is permanent and can't be undone.`}>
        <form onSubmit={runDelete} className="grid gap-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Every image is re-checked on the server right before it is deleted. Anything that no longer qualifies (a new Game Pass, an active game) is skipped.</li>
            <li>Game results and scores are kept; only the photos are removed.</li>
            <li>The run is recorded in the cleanup history.</li>
          </ul>
          <div className="flex items-start gap-3">
            <Checkbox id={confirmId} checked={understood} onCheckedChange={(v) => setUnderstood(v === true)} className="mt-0.5" />
            <label htmlFor={confirmId} className="text-sm font-semibold">I understand these images will be permanently deleted.</label>
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy !== null}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={!understood || busy !== null}>
              {busy === "delete" ? <><Spinner /> Deleting…</> : "Delete permanently"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
