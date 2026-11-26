import type { MetadataRoute } from "next";

import { GUIDES, guidePath } from "@/lib/site/guides";
import { getSiteUrl } from "@/lib/site/url";

/** The public, indexable pages (incl. the /party-games guides). Rooms, dashboards and admin pages are deliberately left out. */
export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl().url;
  return [
    { url: `${site}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/party-games`, changeFrequency: "weekly", priority: 0.9 },
    ...GUIDES.map((g) => ({ url: `${site}${guidePath(g.slug)}`, lastModified: g.updated, changeFrequency: "monthly" as const, priority: 0.8 })),
    { url: `${site}/play`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${site}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${site}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
