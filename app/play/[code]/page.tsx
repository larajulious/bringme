import { notFound, redirect } from "next/navigation";

import { ROOM_CODE } from "@/lib/site/url";

/** Old link format: forward to /join/<code>. */
export default async function LegacyJoinRedirect({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  if (!ROOM_CODE.test(code)) notFound();
  redirect(`/join/${code}`);
}
