import { updateSession } from "@/lib/supabase/proxy";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  // Supabase Auth sends a failed email link (expired / already used) to its redirect URL with
  // ?error=…&error_code=… (e.g. the home page). Send them to sign-in with a friendly notice instead.
  const { pathname, searchParams } = request.nextUrl;
  if (searchParams.has("error_code") && !pathname.startsWith("/auth/") && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/login";
    url.search = "?error=link_invalid";
    return NextResponse.redirect(url);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images - .svg, .png, .jpg, .jpeg, .gif, .webp
 * - media - .mp4, .webm (public videos; must not be redirected to sign-in)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm)$).*)",
  ],
};
