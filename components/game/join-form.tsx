"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NAME_MAX } from "@/lib/players/validation";

const errors: Record<string, string> = {
  invalid_nickname: "Pick a name with at least one letter or number (up to 24 characters).",
  nickname_taken: "Someone already took that name. Try another!",
  game_full: "Player limit reached: this room is full.",
  game_not_joinable: "This game isn't taking players right now.",
  game_not_found: "We can't find that room any more.",
  player_removed: "The Game Master removed you from this game.",
  network: "Can't reach the server. Check your connection and try again.",
};

/** One field, one big button. The server validates everything again. */
export function JoinForm({ code }: { code: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (name.trim() === "") return setError(errors.invalid_nickname);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/play/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ joinCode: code, nickname: name }),
      });
      if (res.ok) {
        router.replace(`/join/${code}/lobby`);
        return;
      }
      const { error: c } = (await res.json().catch(() => ({}))) as { error?: string };
      setError(errors[c ?? ""] ?? "Something went wrong. Please try again.");
      if (c === "game_full" || c === "game_not_joinable" || c === "game_not_found" || c === "player_removed") router.refresh();
    } catch {
      setError(errors.network);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="grid gap-5 short:gap-3" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="player-name" className="text-lg short:text-base">What should we call you?</Label>
        <Input
          id="player-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }}
          maxLength={NAME_MAX * 2} autoComplete="nickname" autoCapitalize="words" enterKeyHint="go"
          placeholder="Your name" aria-invalid={!!error} aria-describedby={error ? "player-name-error" : undefined}
          className="h-16 rounded-3xl text-xl tiny:h-14"
        />
        {error ? (
          <p id="player-name-error" role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 font-semibold text-destructive">{error}</p>
        ) : null}
      </div>
      <Button type="submit" size="lg" disabled={busy} className="h-16 w-full text-xl tiny:h-14">
        {busy ? "Joining…" : "Join Game"}
      </Button>
    </form>
  );
}
