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
