import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunRow } from "@/components/runs/run-row";
import type { RunSummary } from "@/lib/api/runs";

const run: RunSummary = {
  id: "5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3",
  origin: "slack",
  status: "awaiting_approval",
  shadow: false,
  summary: "checkout button does nothing on Android",
  channelId: "C1",
  channelName: "zellify-pulsefit",
  customerSlug: "pulsefit",
  createdAt: 0,
  updatedAt: 0,
  costUsd: "0.412700000",
  turns: 3,
  openApprovalId: "apr:1",
};

describe("RunRow", () => {
  it("shows summary, channel, spend and an attention mark for an open approval", () => {
    render(
      <ul>
        <RunRow run={run} selected={false} now={600_000} href="/runs/x" />
      </ul>
    );
    expect(screen.getByText(/checkout button/)).toBeInTheDocument();
    expect(screen.getByText("#zellify-pulsefit")).toBeInTheDocument();
    expect(screen.getByText("$0.412700000")).toBeInTheDocument();
    expect(screen.getByLabelText("needs a decision")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/runs/x");
  });
  it("marks the selected row", () => {
    render(
      <ul>
        <RunRow
          run={{ ...run, openApprovalId: null }}
          selected
          now={0}
          href="/runs/x"
        />
      </ul>
    );
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByLabelText("needs a decision")).toBeNull();
  });
});
