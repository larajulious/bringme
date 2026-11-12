import type { MetadataRoute } from "next";

import { getSiteUrl } from "@/lib/site/url";

/** The public, indexable pages. Rooms, dashboards and admin pages are deliberately left out. */
export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl().url;
  return [
    { url: `${site}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/play`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${site}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${site}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
