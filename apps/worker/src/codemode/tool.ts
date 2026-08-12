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
import { newCodeExecution } from "./bindings/shared";
import {
  alwaysFresh,
  type AgentExecutionGuard,
  type CapabilityAuditSink,
  type CodeModeLimits,
  type CodeModeScope,
} from "./contracts";
import { renderCapabilityDeclarations } from "./dts";
import { CapabilityError, safeMessage } from "./errors";
import type { CapabilityDependencies } from "./gateways";
import { guardLoader } from "./guarded-loader";
import { makeGuardedExecutor, TRUNCATION_MARK } from "./executor";
import { buildRegistry } from "./registry";

/**
 * What the trusted parent knows about one `run_code` call, distilled to the two
 * facts the capability layer needs: which tool call this is, and whether the
 * caller is still waiting.
 *
 * Both come from the AI SDK's `ToolExecutionOptions`. They are read from it
 * rather than reconstructed, because a locally invented subset drifts silently
 * the first time the SDK changes what it supplies.
 */
export type CodeExecutionContext = {
  outerToolCallId: string;
  abortSignal?: AbortSignal;
};

export type MakeRunCodeToolInput = {
  scope: CodeModeScope;
  deps: CapabilityDependencies;
  limits: CodeModeLimits;
  /**
   * One sink per execution, not one sink per tool.
   *
   * A factory rather than a value because the sink is where Phase 10 attaches a
   * `run_code` call's nested activity to that call's record in the RunDO. A
   * single shared sink cannot say which of an agent loop's ten tool calls an
   * event belongs to, and by the time that matters someone is reading the log
   * because something went wrong.
   */
  auditForExecution(context: CodeExecutionContext): CapabilityAuditSink;
  guard: AgentExecutionGuard;
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
 * ONE tool instance, MANY executions. An agent loop calls the same instance on
 * every step, so nothing execution-shaped may be captured by this factory. The
 * runtime registry, the call budget, the audit sink, the memory citation cache
 * and the customer references are all built inside `execute` and discarded with
 * it; `newCodeExecution` is the single place that constructs them. The factory
 * captures only things that are genuinely constant for the whole run: the
 * trusted scope, the gateways, the limits, the loader and the guard.
 *
 * This comment used to claim "a fresh registry per invocation, never cached"
 * while the implementation built one registry per FACTORY. The code now matches
 * the sentence. A comment asserting an isolation property the code does not
 * have is worse than no comment, because it is what a reviewer trusts instead
 * of reading the constructor.
 */
export function makeRunCodeTool(
  input: MakeRunCodeToolInput,
): Tool<{ code: string }, CodeModeOutput> {
  // Schema-only. Its capability closures are never invoked: nothing but
  // `renderCapabilityDeclarations` ever touches this registry, and it is
  // deliberately NOT the one handed to runCode(). Rendering needs the input and
  // output schemas, which do not vary by execution — but the closures around
  // them hold execution state, so reusing this one is the exact defect above.
  // It is given a throwaway execution whose audit sink drops everything, so a
  // future refactor that accidentally executed through it would record nothing
  // and fail loudly in the audit assertions rather than quietly succeed.
  const declarationOnlyRegistry = buildRegistry(
    input.scope,
    input.deps,
    input.limits,
    newCodeExecution({
      outerToolCallId: "declarations-only",
      audit: discardingSink(),
      guard: alwaysFresh(),
      limits: input.limits,
      clock: input.deps.clock,
    }),
  );

  const description = RULES.replace(
    "{{types}}",
    renderCapabilityDeclarations(declarationOnlyRegistry),
  );

  const loader = guardLoader(input.loader, input.limits);

  return tool({
    description,
    // Exactly one field. No timeout, no network toggle, no bindings, no scope:
    // every execution knob is a reviewed constant, and a strict schema is what
    // stops one being smuggled in as an extra property.
    inputSchema: z.strictObject({
      code: z.string().min(1).max(input.limits.maxCodeChars),
    }),
    execute: async ({ code }, options): Promise<CodeModeOutput> => {
      const startedAt = input.deps.clock();
      const context: CodeExecutionContext = {
        outerToolCallId: outerToolCallId(options),
        abortSignal: options?.abortSignal,
      };

      const failure = (err: unknown, capabilityCalls: number): CodeModeOutput => ({
        result: null,
        logs: [],
        error: normalizeFailure(err),
        truncation: { result: false, logs: false },
        metrics: {
          durationMs: input.deps.clock() - startedAt,
          capabilityCalls,
        },
      });

      // FIRST, before the isolate and before anything is built for this call.
      // The cheapest possible refusal: a superseded step should not pay for a
      // Worker load, and should not open an audit record for work that is not
      // going to happen.
      try {
        await input.guard.assertFresh();
      } catch (err) {
        return failure(err, 0);
      }

      // Everything below belongs to THIS execution and is discarded with it.
      const execution = newCodeExecution({
        outerToolCallId: context.outerToolCallId,
        audit: input.auditForExecution(context),
        guard: input.guard,
        limits: input.limits,
        clock: input.deps.clock,
        abortSignal: context.abortSignal,
      });

      const finish = (
        partial: Omit<CodeModeOutput, "metrics">,
      ): CodeModeOutput => ({
        ...partial,
        metrics: {
          durationMs: input.deps.clock() - startedAt,
          // Read off this execution's own counter. The WeakMap-of-sinks
          // indirection this replaced existed only to reach a count the factory
          // had already made shared; with per-execution state there is one
          // obvious number and no way to read someone else's.
          capabilityCalls: execution.counter.used,
        },
      });

      try {
        const registry = buildRegistry(
          input.scope,
          input.deps,
          input.limits,
          execution,
        );
        const output = await runCode({
          code,
          // Built here rather than once per factory so the race can honour THIS
          // execution's abort signal without seeing any other execution's.
          executor: makeGuardedExecutor(
            loader,
            input.limits,
            input.deps.clock,
            context.abortSignal,
          ),
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
        return failure(err, execution.counter.used);
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
 * The outer tool call this execution belongs to.
 *
 * The AI SDK always supplies one. The fallback is for a host-side caller
 * driving `execute` directly, and it MINTS rather than reusing a constant:
 * `cap:unknown:1` from two such calls would collide, which is precisely the
 * defect the id exists to prevent.
 */
function outerToolCallId(options?: { toolCallId?: string }): string {
  const supplied = options?.toolCallId;
  return typeof supplied === "string" && supplied.length > 0
    ? supplied
    : `local_${crypto.randomUUID()}`;
}

/** Accepts and drops every event. Only for the declarations-only registry. */
function discardingSink(): CapabilityAuditSink {
  return {
    async started() {},
    async completed() {},
    async failed() {},
  };
}

export { renderCapabilityDeclarations, safeMessage };
