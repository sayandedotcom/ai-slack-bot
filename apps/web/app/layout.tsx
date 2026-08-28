import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "@/components/shell/providers";

/**
 * One family, two voices, and the split carries meaning rather than taste.
 *
 * Half of what this page shows is machine output — channel ids, thread
 * timestamps, run uuids, capability calls, counts — and half is what a person
 * typed. Geist Mono is used for the first, Geist for the second, and the
 * rule holds everywhere including the approval card, where the agent's DRAFT is
 * deliberately set in sans: the entire claim of the product is that the reply
 * will read as though Luka wrote it, so it must not look machine-made here.
 */
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
