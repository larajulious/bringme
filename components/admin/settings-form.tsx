"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";
import type { PlatformSettings } from "@/lib/supabase/database.types";

export function SettingsForm({ settings }: { settings: PlatformSettings }) {
  const router = useRouter();
  const { toast } = useToast();
  const [maxPlayers, setMaxPlayers] = useState(String(settings.default_max_players));
  const [photoMb, setPhotoMb] = useState(String(settings.max_photo_size_mb));
  const [retention, setRetention] = useState(String(settings.photo_retention_days));
  const [email, setEmail] = useState(settings.support_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const err = await adminFetch("/api/admin/settings", "PUT", {
      default_max_players: Number(maxPlayers),
      max_photo_size_mb: Number(photoMb),
      photo_retention_days: Number(retention),
      support_email: email.trim() || null,
    });
    setBusy(false);
    if (err) return setError(adminErrorMessage(err));
    toast("Settings saved", "success");
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Games</CardTitle>
          <CardDescription>Applied to new games. A subscriber&apos;s plan can still lower it.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="s-players">Default maximum players</Label>
          <Input id="s-players" type="number" min={2} max={500} value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} required />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
          <CardDescription>Player photo submissions.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="s-photo">Maximum photo size (MB)</Label>
            <Input id="s-photo" type="number" min={1} max={20} value={photoMb} onChange={(e) => setPhotoMb(e.target.value)} required aria-describedby="s-photo-hint" />
            <p id="s-photo-hint" className="text-xs text-muted-foreground">Enforced by private storage on every upload.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="s-retention">Photo retention (days)</Label>
            <Input id="s-retention" type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} required aria-describedby="s-ret-hint" />
            <p id="s-ret-hint" className="text-xs text-muted-foreground">
              Saved now. Automatic deletion needs a scheduled cleanup job, which isn&apos;t running yet.
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Support</CardTitle>
          <CardDescription>Shown to subscribers whose access is restricted.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="s-email">Support email</Label>
          <Input id="s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="support@example.com" maxLength={254} />
        </CardContent>
      </Card>
      {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
      <div><Button type="submit" size="lg" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button></div>
    </form>
  );
}
