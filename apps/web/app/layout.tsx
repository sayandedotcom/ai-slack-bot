import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import "./globals.css";

import { Providers } from "@/components/shell/providers";

/**
 * One family, two voices, and the split carries meaning rather than taste.
 *
 * Half of what this page shows is machine output — channel ids, thread
 * timestamps, run uuids, capability calls, counts — and half is what a person
 * typed. Plex Mono is used for the first, Plex Sans for the second, and the
 * rule holds everywhere including the approval card, where the agent's DRAFT is
 * deliberately set in sans: the entire claim of the product is that the reply
 * will read as though Luka wrote it, so it must not look machine-made here.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Fire-Fighter",
  description:
    "The agent that answers customer threads in Slack, and the one place a human approves what it says.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `suppressHydrationWarning` is required by next-themes: it writes the
    // theme class onto <html> before React hydrates, which is the whole point —
    // without it the first paint is the wrong theme.
    <html lang="en" suppressHydrationWarning>
      <body className={`${plexSans.variable} ${plexMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
