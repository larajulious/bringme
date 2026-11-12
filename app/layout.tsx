import type { Metadata, Viewport } from "next";
import { Fredoka, Nunito } from "next/font/google";

import { HydrationMark } from "@/components/layout/fit-viewport";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(defaultUrl),
  title: {
    default: "BringMe! — The real-time party game",
    template: "%s · BringMe!",
  },
  description:
    "Host a party game, share a QR code and let everyone join in seconds. No sign-up needed to play.",
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
      </body>
    </html>
  );
}
