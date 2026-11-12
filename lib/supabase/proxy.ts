import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hasEnvVars } from "../utils";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  // If the env vars are not set, skip proxy check. You can remove this
  // once you setup the project.
  if (!hasEnvVars) {
    return supabaseResponse;
  }

  // With Fluid compute, don't put this client in a global environment
  // variable. Always create a new one on each request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and
  // supabase.auth.getClaims(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: If you remove getClaims() and you use server-side rendering
  // with the Supabase client, your users may be randomly logged out.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  const path = request.nextUrl.pathname;
  const isPublic =
    path === "/" ||
    path === "/terms" ||
    path === "/privacy" ||
    // Crawler and browser files (search engines, social previews, "Add to Home Screen")
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    path === "/manifest.webmanifest" ||
    path.startsWith("/auth") ||
    path === "/admin/login" ||
    // Players join without an account
    path.startsWith("/play") ||
    path.startsWith("/join") ||
    // Guest APIs authenticate with their own player token inside the handler
    path.startsWith("/api/play") ||
    // Polar webhooks carry no session: the handler verifies the Standard Webhooks signature
    path === "/api/webhooks/polar" ||
    // Homepage tap counter: anonymous by design; throttled + rate-limited in the handler and in SQL
    path === "/api/snappy" ||
    // Signup pre-check (disposable email domains): answers only "allowed or not" for a domain, rate-limited
    path === "/api/auth/email-check";

  if (!user && !isPublic) {
    // Coarse gate only. Pages/handlers re-check authorization on the server.
    // APIs answer like the handlers themselves would (a redirect to the login
    // page made fetch() end on an HTML 405, hiding "session ended" from the UI).
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const hadSession = request.cookies
      .getAll()
      .some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
    const url = request.nextUrl.clone();
    const isAdminArea = path === "/admin" || path.startsWith("/admin/");
    url.pathname = isAdminArea ? "/admin/login" : "/auth/login";
    url.search = "";
    if (hadSession) url.searchParams.set("reason", "expired");
    if (request.method === "GET" && !path.startsWith("/api")) {
      url.searchParams.set("next", path + request.nextUrl.search); // keep e.g. ?buy=party (validated by safeNext later)
    }
    return NextResponse.redirect(url);
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  return supabaseResponse;
}
