/**
 * TEMPORARY SCAFFOLD — Task 8 deletes this file.
 *
 * `createExecuteTool` refuses to build with nothing to expose
 * (`@cloudflare/think/dist/tools/execute.js:84`: "has nothing to expose —
 * provide at least one of `tools`, `state`, `browser`, or `connectors`"), and
 * the real connectors do not exist until the capability registry lands in
 * Task 8.
 *
 * Deferring the Code Mode runtime until then would also defer the only check
 * that proves the `v5` migration wired the `CodemodeRuntime` facet correctly —
 * and `facets.get` is lazy, so nothing but a real call into it can tell. A
 * migration mistake found in Task 8 would mean every Wave 1 task was built on
 * a broken foundation, and migrations are append-only. So the facet is proven
 * now, against this one placeholder namespace.
 *
 * It is not reachable by a model: there is no wake path until Task 19 and no
 * transport until Task 22. `test/capabilities-registry.test.ts` (Task 8) asserts
 * this namespace is gone.
 */
import { CodemodeConnector } from "@cloudflare/codemode";

import type { Env } from "../index";

export const BOOT_PROBE_NAMESPACE = "bootProbe";

export class BootProbeConnector extends CodemodeConnector<Env> {
  name(): string {
    return BOOT_PROBE_NAMESPACE;
  }

  protected tools() {
    return {
      ping: {
        description: "Placeholder. Returns true. Removed in Task 8.",
        // A JSON Schema, never a raw Zod object: codemode accepts a Zod schema
        // silently (it has .type === "object") and degrades the model-facing
        // type to `unknown`. Task 7 makes that a hard error.
        inputSchema: { type: "object" as const, properties: {}, required: [] },
        execute: async () => ({ ok: true }),
      },
    };
  }
}
