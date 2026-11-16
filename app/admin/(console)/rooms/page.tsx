import type { Metadata } from "next";
import Link from "next/link";
import { DoorOpen } from "lucide-react";

import { RoomClose } from "@/components/admin/room-close";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { listActiveRooms } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Active rooms" };

const TYPE_LABEL = { bring_me: "Bring Me", bingosnap: "BingoSnap" } as const;

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function ActiveRoomsPage() {
  await requireAdminPage();
  const rooms = await listActiveRooms();

  return (
    <>
      <BackBar href="/admin/dashboard" label="Dashboard" />
      <PageHeading title="Active rooms" description="Games waiting in the lobby or live right now, and who is hosting them." />

      {rooms.length === 0 ? (
        <EmptyState icon={<DoorOpen />} title="No active rooms" description="Rooms appear here while they are in the lobby or live." />
      ) : (
        <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <caption className="sr-only">Active rooms and their hosts</caption>
            <thead className="bg-secondary text-secondary-foreground">
              <tr>
                {["Room", "Status", "Created by", "Players", "Started"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                ))}
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rooms.map((r) => (
                <tr key={r.game_id}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/games/${r.game_id}`} className="block break-words font-semibold text-primary underline-offset-4 hover:underline">{r.title}</Link>
                    <div className="text-muted-foreground">{TYPE_LABEL[r.game_type]} · <span className="font-mono">{r.join_code}</span></div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={r.status === "live" ? "success" : "yellow"}>{r.status === "live" ? "Live" : "Lobby"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/admin/subscribers/${r.owner_id}`} className="font-semibold text-primary underline-offset-4 hover:underline">
                      {r.owner_name ?? r.owner_email ?? "Unknown host"}
                    </Link>
                    {r.owner_name && r.owner_email ? <div className="text-muted-foreground">{r.owner_email}</div> : null}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{Number(r.player_count)}</td>
                  <td className="px-4 py-3">{formatWhen(r.started_at ?? r.created_at)}{r.started_at ? "" : " (created)"}</td>
                  <td className="px-4 py-3 text-right"><RoomClose gameId={r.game_id} title={r.title} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
