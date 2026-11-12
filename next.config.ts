import type { NextConfig } from "next";

/**
 * Baseline security headers for every response. The camera is used only by
 * this origin's player screen; nothing needs microphone/location/payment.
 * Framing is denied so host/admin controls cannot be clickjacked.
 * (A full Content-Security-Policy needs per-request nonces with Cache
 * Components; see PRODUCTION_READINESS.md.)
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  poweredByHeader: false,
  // Dev only (ignored by `next start`): let a Cloudflare quick tunnel load dev
  // JS/HMR. Without it the page never hydrates and forms submit natively.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Retired password screens: one passwordless page now handles sign-in and sign-up (query, e.g. ?next=, is kept).
  async redirects() {
    return ["/auth/sign-up", "/auth/sign-up-success", "/auth/forgot-password", "/auth/update-password"].map((source) => ({
      source,
      destination: "/auth/login",
      permanent: false,
    }));
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
