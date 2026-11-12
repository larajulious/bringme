import Link from "next/link";
import { Ban, PauseCircle, ShoppingBag, TimerOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { AccessState } from "@/lib/supabase/database.types";

const PLANS = "/dashboard/subscription#plans";

const copy = {
  purchase_required: {
    icon: <ShoppingBag />,
    title: "Purchase required",
    description: "Choose a 7-Day Game Pass to start hosting. One-time purchase, no automatic renewal.",
  },
  trial_expired: {
    icon: <TimerOff />,
    title: "Trial expired",
    description: "Your free trial has ended. Choose a 7-Day Game Pass to continue hosting. Your games and results are safe.",
  },
  pass_expired: {
    icon: <TimerOff />,
    title: "Pass expired",
    description: "Your Game Pass has ended. Choose a 7-Day Game Pass to continue hosting. Your games and results are safe.",
  },
  suspended: {
    icon: <PauseCircle />,
    title: "Your access is paused",
    description: "An admin has paused your hosting access. Your games are safe. Please reach out to the BringMe! team to find out more.",
  },
  deactivated: {
    icon: <Ban />,
    title: "This account is deactivated",
    description: "Hosting is unavailable because this account has been deactivated. Please contact the BringMe! team if you think this is a mistake.",
  },
} as const;

/**
 * Shown instead of hosting tools when the host has no active Game Pass. Purely informative:
 * creating and starting games is refused by the database whatever the UI shows.
 */
export function SubscriptionRestricted({
  state,
  supportEmail,
  trialEnded = false,
}: {
  state: Exclude<AccessState, "active">;
  supportEmail?: string | null;
  /** The host's only access was the free trial and it has ended. */
  trialEnded?: boolean;
}) {
  const key = state === "pending" ? "purchase_required" : state === "expired" ? (trialEnded ? "trial_expired" : "pass_expired") : state;
  const { icon, title, description } = copy[key];
  const buyable = key === "purchase_required" || key === "trial_expired" || key === "pass_expired";
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={
        buyable ? (
          <Button asChild><Link href={PLANS}>Choose a Game Pass</Link></Button>
        ) : supportEmail ? (
          <a href={`mailto:${supportEmail}`} className="font-semibold text-primary underline underline-offset-4">
            Contact {supportEmail}
          </a>
        ) : undefined
      }
    />
  );
}
