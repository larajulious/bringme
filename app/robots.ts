import type { MetadataRoute } from "next";

import { getSiteUrl } from "@/lib/site/url";

/**
 * Public pages are crawlable. Private areas are disallowed outright. Join links are NOT disallowed:
 * X / Facebook / WhatsApp need to fetch them for invite previews, and their pages carry `noindex`
 * so they still never appear in search.
 */
export default function robots(): MetadataRoute.Robots {
  const site = getSiteUrl().url;
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/dashboard", "/admin", "/api/", "/present/", "/auth/"] }],
    sitemap: `${site}/sitemap.xml`,
    host: site,
  };
}
