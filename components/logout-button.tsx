"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton({ redirectTo = "/auth/login" }: { redirectTo?: string }) {
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    await createClient().auth.signOut();
    // Full navigation: drops all cached authenticated pages.
    window.location.assign(redirectTo);
  };

  return (
    <Button onClick={logout} variant="outline-light" size="sm" disabled={busy}>
      {busy ? "Signing out…" : "Log out"}
    </Button>
  );
}
