// Forced before any of the app's own modules are imported, so `isDemo()` (and
// therefore every hook `RunInspector` reads through) resolves to the fixture
// tree rather than a live `fetch`. See `test/api-client.test.ts`.
process.env.NEXT_PUBLIC_DEMO = "1";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { describe, expect, it } from "vitest";

import { RunInspector } from "@/components/runs/run-inspector";
import type { RunDetail } from "@/lib/api/runs";
import { demoUsageTotals } from "@/lib/fixtures/runs";
import { usd } from "@/lib/format";

// The one demo run whose effects ledger (`lib/fixtures/effects.ts`) carries a
// `github.openPR` call with a `url` — the only fixture row that exercises the
// "Did" section's link-only-when-the-ledger-has-a-url rule.
const MACROSNAP_RUN_ID = "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258";
const PR_URL = "https://github.com/Zellify/web2app-rebuild/pull/1287";

const run: RunDetail = {
  id: MACROSNAP_RUN_ID,
  origin: "slack",
  status: "done",
  shadow: false,
  summary: "small ask — a button to copy the funnel ID from the dashboard",
  channelId: "C0MACROSNAP",
  threadTs: null,
  createdAt: Date.now() - 74 * 60_000,
  updatedAt: Date.now() - 61 * 60_000,
};

function renderInspector() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunInspector run={run} now={Date.now()} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("RunInspector", () => {
  it("shows what the run did — a real PR link, never a guessed one — and what it spent", async () => {
    renderInspector();

    // The fixture arrives after a deliberate latency (`FIXTURE_LATENCY_MS` in
    // `lib/api/client.ts`), so every assertion below waits for the panels to
    // leave their loading state.
    expect(await screen.findByText("openPR")).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: "open openPR result",
    });
    expect(link).toHaveAttribute("href", PR_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");

    // usd() truncates the ledger's nine-decimal string to four places.
    await waitFor(() => {
      expect(
        screen.getByText(usd(demoUsageTotals[MACROSNAP_RUN_ID] as string))
      ).toBeInTheDocument();
    });
  });
});
