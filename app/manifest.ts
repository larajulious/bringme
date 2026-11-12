import type { MetadataRoute } from "next";

import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from "@/lib/site/seo";

/** Web app manifest: name, colours and icons for "Add to Home Screen" and app listings. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_TITLE,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#2e1065",
    theme_color: "#4c1d95",
    categories: ["games", "entertainment"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
