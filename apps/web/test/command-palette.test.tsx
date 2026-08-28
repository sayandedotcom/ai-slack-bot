import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The palette had a runtime crash that every existing test missed, because the
 * only test covered `paletteItems` — a pure function — and nothing ever
 * RENDERED the thing. `CommandDialog` in this registry does not supply the
 * `Command` root, so `CommandPrimitive.Input` read an undefined context and
 * threw `Cannot read properties of undefined (reading 'subscribe')` the moment
 * anyone pressed ⌘K.
 *
 * A pure-function test cannot catch that. This one mounts the palette OPEN,
 * which is the only shape in which the bug exists.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_DEMO = "1";
  // cmdk measures its list; jsdom has no layout engine.
  Element.prototype.scrollIntoView = vi.fn();
});

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
}

describe("CommandPalette", () => {
  it("mounts open without throwing, and shows its input", async () => {
    const { CommandPalette } = await import(
      "@/components/common/command-palette"
    );
    wrap(<CommandPalette open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/jump to a page, run or approval/i)
      ).toBeInTheDocument();
    });
  });

  it("lists the pages a reader can jump to", async () => {
    const { CommandPalette } = await import(
      "@/components/common/command-palette"
    );
    wrap(<CommandPalette open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeInTheDocument();
    });
    // Chat was restored after the redesign deleted it; the palette must know.
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();
  });

  it("renders nothing when closed", async () => {
    const { CommandPalette } = await import(
      "@/components/common/command-palette"
    );
    wrap(<CommandPalette open={false} onOpenChange={() => {}} />);

    expect(
      screen.queryByPlaceholderText(/jump to a page, run or approval/i)
    ).toBeNull();
  });
});
