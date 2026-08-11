import { tool, type Tool } from "ai";
import { z } from "zod";
import { runCode } from "@cloudflare/codemode";
// DELIBERATELY the index entry's resolveProvider, NOT `@cloudflare/codemode/ai`.
//
// The two are not interchangeable. The /ai one validates with `asSchema` BEFORE
// our execute runs and throws `JSON.stringify(zodIssues)` as the message. Since
// only `message` survives the isolate boundary, the model would receive a raw
// JSON array instead of our `code: message` wire format and could not branch on
// a code — and some issue types echo submitted values back, defeating
// formatZodIssues' name-the-path-never-the-value rule.
//
// The index one does not validate at all, which leaves `defineCapability`'s
// parse as the only validator and every rejection well-formed. Counter-
// intuitive, measured 2026-08-12, and the reason Task 5 Step 2's assertion had
// to be corrected. Do not "fix" this import.
import { resolveProvider } from "@cloudflare/codemode";
import type { JsonValue } from "../run/protocol";
import type {
  CapabilityAuditSink,
  CodeModeLimits,
  CodeModeScope,
} from "./contracts";
import { renderCapabilityDeclarations } from "./dts";
import { CapabilityError, safeMessage } from "./errors";
import type { CapabilityDependencies } from "./gateways";
import { guardLoader } from "./guarded-loader";
import { makeGuardedExecutor, TRUNCATION_MARK } from "./executor";
import { buildRegistry } from "./registry";

export type MakeRunCodeToolInput = {
  scope: CodeModeScope;
  deps: CapabilityDependencies;
  limits: CodeModeLimits;
  audit: CapabilityAuditSink;
  loader: WorkerLoader;
};

export type CodeModeOutput = {
  result: JsonValue | string | null;
  logs: string[];
  error?: string;
  truncation: { result: boolean; logs: boolean };
  metrics: { durationMs: number; capabilityCalls: number };
};

const RULES = `You have one tool. Write JavaScript that calls the capabilities below.

- Write ONE async arrow function. It is the whole program.
- The declarations are TypeScript, but you are writing JAVASCRIPT. No type
  annotations, no interfaces, no imports.
- Return the final, compact result. Filter and join in code rather than
  returning everything and reasoning over it afterwards — that is the entire
  point of running code instead of calling tools one at a time.
- Use console.log sparingly, for progress worth reading.
- Call namespaces directly: slack.thread({}), memory.recall({...}).
- Catch only errors you can genuinely recover from. An uncaught error comes
  back to you with a code you can act on; a swallowed one does not.
- There is no network. fetch exists but every call is refused. Do not probe
  for hidden variables, globals, or credentials — there are none, and the
  attempt is recorded.
- Do not assume a capability that is not declared below. If you need one that
  does not exist, say so in your answer instead of inventing it.

Errors come back as "code: message". The code is stable; read it and adapt.

Available capabilities:

{{types}}`;

/**
 * The ONLY model-facing tool this phase produces.
 *
 * Everything else — seven namespaces, their credentials, the loader, the
 * executor — lives behind it. Phase 10 receives this factory and nothing else,
 * which is what makes "the model cannot reach a credential" a structural claim
 * rather than a policy one.
 *
 * A fresh registry per invocation, never cached: provider closures hold the
 * trusted scope, the execution-local fact cache and the call counter, so
 * reusing one across turns would leak all three.
 */
export function makeRunCodeTool(
  input: MakeRunCodeToolInput,
): Tool<{ code: string }, CodeModeOutput> {
  const registry = buildRegistry(input.scope, input.deps, input.limits, countingSink(input.audit));

  const description = RULES.replace(
    "{{types}}",
    renderCapabilityDeclarations(registry),
  );

  const executor = makeGuardedExecutor(
    guardLoader(input.loader, input.limits),
    input.limits,
    input.deps.clock,
  );

  return tool({
    description,
    // Exactly one field. No timeout, no network toggle, no bindings, no scope:
    // every execution knob is a reviewed constant, and a strict schema is what
    // stops one being smuggled in as an extra property.
    inputSchema: z.strictObject({
      code: z.string().min(1).max(input.limits.maxCodeChars),
    }),
    execute: async ({ code }): Promise<CodeModeOutput> => {
      const startedAt = input.deps.clock();
      const counter = countedCalls.get(input.audit) ?? { n: 0 };

      const finish = (
        partial: Omit<CodeModeOutput, "metrics">,
      ): CodeModeOutput => ({
        ...partial,
        metrics: {
          durationMs: input.deps.clock() - startedAt,
          capabilityCalls: counter.n,
        },
      });

      try {
        const output = await runCode({
          code,
          executor,
          providers: registry.map((provider) =>
            resolveProvider({ name: provider.name, tools: provider.tools }),
          ),
        });
        const logs = output.logs ?? [];
        const result = (output.result ?? null) as JsonValue | string | null;
        return finish({
          result,
          logs,
          truncation: {
            result: typeof result === "string" && result.includes(TRUNCATION_MARK),
            logs: logs.some((line) => line.includes(TRUNCATION_MARK)),
          },
        });
      } catch (err) {
        // runCode throws on failure, prefixing "Code execution failed: " and
        // appending console output. The AI SDK would surface a throw as an
        // exception; returning it as a value keeps it in the model's tool
        // result where the next turn can actually read it.
        return finish({
          result: null,
          logs: [],
          error: normalizeFailure(err),
          truncation: { result: false, logs: false },
        });
      }
    },
  });
}

/**
 * Strip the package's wrapper and anything resembling a host path.
 *
 * An error the model cannot read costs a whole round trip, which is the cost
 * this phase exists to remove — but a stack trace is not readable, it is noise
 * that also describes our filesystem.
 */
function normalizeFailure(err: unknown): string {
  if (err instanceof CapabilityError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Code execution failed:\s*/, "")
    .replace(/\s*at [^\n]*(\n|$)/g, "")
    .replace(/\/[\w./-]*\/(src|node_modules)\/[\w./-]*/g, "[path]")
    .slice(0, 1800);
}

/**
 * Counts capability calls without changing `buildRegistry`'s shape.
 *
 * A WeakMap keyed by the caller's own sink, so two concurrent executions cannot
 * see each other's count — the same reason the scope is an argument rather than
 * ambient state.
 */
const countedCalls = new WeakMap<CapabilityAuditSink, { n: number }>();

function countingSink(inner: CapabilityAuditSink): CapabilityAuditSink {
  const counter = { n: 0 };
  countedCalls.set(inner, counter);
  return {
    async started(event) {
      await inner.started(event);
    },
    async completed(event) {
      counter.n += 1;
      await inner.completed(event);
    },
    async failed(event) {
      counter.n += 1;
      await inner.failed(event);
    },
  };
}

export { renderCapabilityDeclarations, safeMessage };
