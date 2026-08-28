import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FunnelStrip } from "@/components/dashboard/funnel-strip";

const ready = {
  kind: "ready" as const,
  data: {
    counters: {
      heard: 148,
      ingested: 140,
      triaged: 140,
      woken: 17,
      dropped: 123,
      escalated: 1,
    },
    since: 0,
    window: "24h" as const,
  },
};

describe("FunnelStrip", () => {
  it("renders four counted stages, dropped as a caption, and never the text NaN", () => {
    const { container } = render(
      <FunnelStrip state={ready} window="24h" onWindow={() => {}} />
    );
    expect(screen.getByText("148")).toBeInTheDocument();
    expect(screen.getByText("123 dropped")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
    for (const bar of container.querySelectorAll<HTMLElement>(
      "[data-slot=funnel-bar]"
    )) {
      expect(bar.style.width).toMatch(/^\d+(\.\d+)?%$/);
    }
  });
  it("says quiet when nothing was heard", () => {
    render(
      <FunnelStrip
        state={{
          ...ready,
          data: {
            ...ready.data,
            counters: {
              heard: 0,
              ingested: 0,
              triaged: 0,
              woken: 0,
              dropped: 0,
              escalated: 0,
            },
          },
        }}
        window="24h"
        onWindow={() => {}}
      />
    );
    expect(screen.getByText(/Quiet/)).toBeInTheDocument();
  });
  it("offers the two windows", () => {
    const onWindow = vi.fn();
    render(<FunnelStrip state={ready} window="24h" onWindow={onWindow} />);
    screen.getByRole("button", { name: "7d" }).click();
    expect(onWindow).toHaveBeenCalledWith("7d");
  });
});
