"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Dark is the default because this page is opened at 3am next to a Slack
 * window that is already dark, but light is a real supported theme — every
 * colour in `app/globals.css` is defined for both.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
