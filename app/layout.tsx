import type { Metadata, Viewport } from "next";
import { Fredoka, Nunito } from "next/font/google";

import { CookieNotice } from "@/components/layout/cookie-notice";
import { HydrationMark } from "@/components/layout/fit-viewport";
import { ToastProvider } from "@/components/ui/toast";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE } from "@/lib/site/seo";
import { getSiteUrl } from "@/lib/site/url";
import "./globals.css";

// Absolute URLs in social cards and canonical links come from the configured site URL
// (NEXT_PUBLIC_SITE_URL), never a per-deployment preview host.
const site = getSiteUrl().url;

export const metadata: Metadata = {
  metadataBase: new URL(site),
  applicationName: SITE_NAME,
  title: {
    default: SITE_TITLE,
    template: "%s · BringMe!",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "party game", "office party game", "team building game", "scavenger hunt game", "photo scavenger hunt",
    "QR code game", "Christmas party game", "town hall icebreaker", "photo bingo",
  ],
  category: "games",
  creator: SITE_NAME,
  publisher: SITE_NAME,
  formatDetection: { telephone: false, email: false, address: false },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  // Facebook / LinkedIn / WhatsApp (Open Graph). The image is app/opengraph-image.png (1200×630).
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
  },
  // X / Twitter. The image is app/twitter-image.png.
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#4c1d95",
  width: "device-width",
  initialScale: 1,
};

const display = Fredoka({
  variable: "--font-display",
  display: "swap",
  subsets: ["latin"],
});

const body = Nunito({
  variable: "--font-body",
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <HydrationMark />
        <ToastProvider>{children}</ToastProvider>
        <CookieNotice />
      </body>
    </html>
  );
}
