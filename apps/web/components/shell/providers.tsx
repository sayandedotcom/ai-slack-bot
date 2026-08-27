"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useState } from "react";

import { makeQueryClient } from "@/lib/query/client";

export function Providers({ children }: { children: ReactNode }) {
  // `useState`, not a module constant: a client created at module scope is
  // shared by every request the server renders, which would leak one visitor's
  // roster into another's page.
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {/*
        Dark is the default because this page is opened at 3am next to a Slack
        window that is already dark, but light is a real supported theme —
        every colour in `app/globals.css` is defined for both.
      */}
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem
        disableTransitionOnChange
      >
        {/* One provider at the root: tooltips are used throughout, and nesting
            a provider per panel would give each its own open/close timing. */}
        <TooltipProvider delay={250}>{children}</TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
