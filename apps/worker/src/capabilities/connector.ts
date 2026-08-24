import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";

import { CapabilityError } from "../gateways/errors";
import type { Env } from "../index";
import type { ClassifiedTool } from "./define";
import { toJsonSchema } from "./schema";

/** One capability namespace as the connector layer sees it. */
export type CapabilityNamespace = {
  name: string;
  instructions?: string;
  tools: Record<string, ClassifiedTool>;
};

/**
 * The project's only `CodemodeConnector`.
 *
 * Everything security-relevant already lives inside the tool's `run` — the Zod
 * parse, `withCapabilityAudit`, `assertEffectPermitted`, the effect ledger, the
 * per-execution budget, the redaction — because `auditedCapability` wired it
 * there. This class deliberately re-implements none of it. Its whole job is to
 * present those tools to the codemode runtime in the shape the runtime needs,
 * and it must not become a second place where policy lives.
 *
 * `requiresApproval` is never set, on any tool. Approval is a model decision
 * routed through the `approval` namespace with host-owned state, because the
 * runtime's approve path takes only an `executionId` and therefore cannot carry
 * the text a human edited in the dashboard. Setting it would also collide with
 * `replay: "reexecute"`, which `describe()` rejects. See spec decision R5/D4.
 */
export class FirefighterConnector extends CodemodeConnector<Env> {
  readonly #ns: CapabilityNamespace;

  constructor(ctx: DurableObjectState | ExecutionContext, env: Env, ns: CapabilityNamespace) {
    super(ctx, env);
    this.#ns = ns;
  }

  name(): string {
    return this.#ns.name;
  }

  protected override instructions(): string | undefined {
    return this.#ns.instructions;
  }

  protected tools(): ConnectorTools {
    const out: ConnectorTools = {};
    for (const [method, tool] of Object.entries(this.#ns.tools)) {
      const run = tool.run;
      out[method] = {
        description: tool.description,
        // JSON Schema, NEVER the Zod instance. `toolInputSchema` in the
        // connector base accepts anything with a `type`, `properties` or `$ref`
        // key — and a Zod v4 schema has `.type === "object"`, so a raw Zod
        // schema PASSES that check and is used verbatim as JSON Schema. It has
        // no `.properties`, so the model-facing type degrades to `unknown` and
        // the description is dropped, with no error anywhere.
        inputSchema: toJsonSchema(tool.input),
        outputSchema: tool.output ? toJsonSchema(tool.output) : undefined,
        // Raw, unvalidated args by design: the tool's own Zod parse inside
        // `defineCapability` is the runtime boundary, and it is the one that
        // produces the `invalid_input` the model knows how to read.
        execute: (args: unknown): Promise<unknown> => {
          if (!run) {
            // Unreachable through `auditedCapability`, which always attaches
            // one. Loud rather than silent: a tool with no `run` would
            // otherwise be a declared capability that returns `undefined` and
            // looks like a successful no-op.
            throw new CapabilityError(
              "invalid_context",
              `${this.#ns.name}.${method} has no execute implementation.`,
            );
          }
          return run(args);
        },
      };
    }
    return out;
  }
}
