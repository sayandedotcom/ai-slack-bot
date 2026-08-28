import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Every route, mounted.
 *
 * This suite exists because three defects reached a browser on a branch whose
 * unit tests were green the whole time: a page that scrolled sideways, a
 * transcript that called a customer's words "You", and a command palette that
 * threw the instant it opened. Every one of them only existed WHEN MOUNTED —
 * `tsc` cannot see a missing React context, and a test of a pure function
 * cannot see a component that never renders.
 *
 * So this is deliberately shallow and deliberately wide: it renders each route
 * component and asserts something real appeared. It will not tell you a layout
 * is ugly. It WILL tell you that a route throws, that an import broke, that a
 * required provider is missing, or that a hook was moved out from under a page
 * — which is the whole class of failure that got through.
 *
 * Demo mode is on, so every panel resolves from `lib/fixtures` and nothing
 * reaches the network.
 */

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_DEMO = "1";
  // jsdom has no layout engine; cmdk and the resizable panels both construct
  // observers on mount. No-ops are honest here — nothing in this suite
  // measures anything.
  Element.prototype.scrollIntoView = vi.fn();
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The providers a page genuinely depends on, and no more. Deliberately NOT
 * `AppShell`: the shell reads identity and would make every route's assertion
 * depend on the sidebar rendering, which is a different thing to test.
 */
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delay={0}>{node}</TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * One case per route. `load` is a dynamic import so a module that throws at
 * evaluation fails its own case rather than the whole file, and `expect` names
 * something the page must actually put on screen — a heading, a control, a
 * label — not merely "it did not throw".
 */
const ROUTES: {
  path: string;
  load: () => Promise<{ default: ComponentType<Record<string, never>> }>;
  expect: RegExp;
}[] = [
  {
    path: "/",
    load: () => import("@/app/page"),
    expect: /waiting on you|live runs|speaks as/i,
  },
  {
    path: "/chat",
    load: () => import("@/app/chat/page"),
    expect: /same agent, second door|ask/i,
  },
  {
    path: "/runs",
    load: () => import("@/app/runs/page"),
    expect: /pick a run|no runs match/i,
  },
  {
    path: "/approvals",
    load: () => import("@/app/approvals/page"),
    expect: /waiting on you|decided/i,
  },
  {
    path: "/team",
    load: () => import("@/app/team/page"),
    expect: /who the agent speaks as|roster/i,
  },
  {
    path: "/channels",
    load: () => import("@/app/channels/page"),
    expect: /channels|registry/i,
  },
  {
    path: "/eval",
    load: () => import("@/app/eval/page"),
    expect: /shadow|triage/i,
  },
];

describe("every route mounts", () => {
  for (const route of ROUTES) {
    it(`${route.path} renders without throwing`, async () => {
      const mod = await route.load();
      const Page = mod.default;

      mount(<Page />);

      // Fixtures resolve after a deliberate latency, so the first paint is
      // skeletons. Waiting for real copy is what proves the page got past its
      // loading state rather than merely mounting an empty shell.
      await waitFor(
        () => {
          expect(screen.getAllByText(route.expect).length).toBeGreaterThan(0);
        },
        { timeout: 4000 }
      );
    });
  }
});

/**
 * The shell chrome, which every route inherits and no route test covers. A
 * broken sidebar or header takes down all seven pages at once, so it gets its
 * own case rather than riding on one route's.
 */
describe("the shell mounts", () => {
  it("renders the sidebar with every route in it", async () => {
    const { AppSidebar } = await import("@/components/shell/app-sidebar");
    const { SidebarProvider } = await import(
      "@workspace/ui/components/sidebar"
    );

    mount(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeInTheDocument();
    });
    for (const label of [
      "Chat",
      "Runs",
      "Approvals",
      "Team",
      "Channels",
      "Eval",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders the header", async () => {
    const { SiteHeader } = await import("@/components/shell/site-header");
    const { SidebarProvider } = await import(
      "@workspace/ui/components/sidebar"
    );

    mount(
      <SidebarProvider>
        <SiteHeader onOpenPalette={() => {}} />
      </SidebarProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeInTheDocument();
    });
  });
});
