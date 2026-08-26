import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `globals` is off, so React Testing Library's own auto-cleanup never
// registers. Without this, a component from one test is still mounted while
// the next one queries the document.
afterEach(cleanup);
