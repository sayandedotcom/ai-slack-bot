import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `globals` is off, so React Testing Library's own auto-cleanup never
// registers. Without this, a component from one test is still mounted while
// the next one queries the document.
afterEach(cleanup);

/**
 * jsdom implements no layout engine, so it ships no `ResizeObserver` — and
 * `cmdk` constructs one as soon as the command palette mounts. Without this
 * stub the palette cannot be rendered in a test AT ALL, which is precisely how
 * a crash-on-open shipped: the only palette test covered a pure function.
 *
 * A no-op is the honest stub. Nothing here measures anything, and a test that
 * depended on real observed sizes would be lying about what jsdom can do.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * Same shape of gap: jsdom has no media queries, and the sidebar's
 * `use-mobile` hook calls `window.matchMedia` on mount — so without this the
 * shell cannot be rendered in a test either.
 *
 * It answers "not mobile" for every query. That is the desktop layout, which
 * is the one these tests are about; a suite that needs the mobile branch
 * should override this per-test rather than trust a global default.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
