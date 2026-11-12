import { Clock, DoorClosed, Hourglass, Grid3x3, QrCode, Trophy } from "lucide-react";

import type { OnScreen } from "@/components/game/on-screen-now";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";

/** What /present/[id] shows for a BingoSnap game in this state (mirrors components/bingosnap/presenter-screen.tsx). */
export function bingoOnScreen(s: BingoHostSnapshot, beforeHunt: boolean, over: boolean): OnScreen {
  if (s.status === "cancelled") return { key: "ended", Icon: DoorClosed, title: "Game ended" };
  if (s.status === "completed" || s.board.resultsAt) return { key: "results", Icon: Trophy, title: "Results", detail: s.board.winnerRule === "first" ? "The first verified Bingo" : "Verified winners, in order" };
  if (s.status !== "active") {
    return { key: "join", Icon: QrCode, title: "Join screen", detail: `QR code and room ${s.joinCode} · ${s.players.filter((p) => p.state === "active").length} joined` };
  }
  if (beforeHunt) return { key: "count", Icon: Clock, title: "3-2-1 countdown", detail: "Get your cameras ready" };
  if (over) return { key: "over", Icon: Hourglass, title: "Time's up", detail: "Checking the claims" };
  return { key: "hunt", Icon: Grid3x3, title: "The hunt", detail: `Challenges, timer and verified Bingos · ${s.submissions.length} ${s.submissions.length === 1 ? "claim" : "claims"} in` };
}
