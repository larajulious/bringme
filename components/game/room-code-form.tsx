"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROOM_CODE } from "@/lib/site/url";

/** For players who can't scan: type the 6-character room code. */
export function RoomCodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!ROOM_CODE.test(c)) return setError("Room codes have 6 letters or numbers.");
    router.push(`/join/${c}`);
  };

  return (
    <form onSubmit={submit} className="grid gap-4 short:gap-3" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="room-code" className="text-base">Room code</Label>
        <Input
          id="room-code" value={code} autoComplete="off" autoCapitalize="characters" spellCheck={false}
          maxLength={6} inputMode="text" enterKeyHint="go" placeholder="ABC123"
          onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); setError(null); }}
          aria-invalid={!!error} aria-describedby={error ? "room-code-error" : undefined}
          className="h-16 text-center font-display text-3xl tiny:h-14 font-bold uppercase tracking-[0.3em]"
        />
        {error ? <p id="room-code-error" role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
      </div>
      <Button type="submit" size="lg" className="h-16 w-full text-xl tiny:h-14">Find game</Button>
    </form>
  );
}
