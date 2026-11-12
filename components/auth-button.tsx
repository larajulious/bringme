import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { Button } from "./ui/button";

/** Landing header actions. Colours assume the dark purple header. */
export async function AuthButton() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  return data?.claims ? (
    <Button asChild size="sm">
      <Link href="/auth/continue">Dashboard</Link>
    </Button>
  ) : (
    // Same passwordless page; "Get started" opens it on the Create account tab.
    <div className="flex gap-2">
      <Button asChild size="sm" variant="outline-light">
        <Link href="/auth/login">Sign in</Link>
      </Button>
      <Button asChild size="sm">
        <Link href="/auth/login?mode=signup">Get started</Link>
      </Button>
    </div>
  );
}
