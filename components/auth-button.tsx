import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { Button } from "./ui/button";

/**
 * Landing header actions. Colours assume the dark purple header. `split` returns the actions as separate
 * flex items (primary first) so a header with `justify-between` puts "Get started" on the left, "Sign in" on the right.
 */
export async function AuthButton({ split = false }: { split?: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (data?.claims) {
    return (
      <Button asChild size="sm">
        <Link href="/auth/continue">Dashboard</Link>
      </Button>
    );
  }

  // Same passwordless page; "Get started" opens it on the Create account tab.
  const signIn = (
    <Button asChild size="sm" variant="outline-light">
      <Link href="/auth/login">Sign in</Link>
    </Button>
  );
  const getStarted = (
    <Button asChild size="sm">
      <Link href="/auth/login?mode=signup">Get started</Link>
    </Button>
  );
  return split ? <>{getStarted}{signIn}</> : <div className="flex gap-2">{signIn}{getStarted}</div>;
}
