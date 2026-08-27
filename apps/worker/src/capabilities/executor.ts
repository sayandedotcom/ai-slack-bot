import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type {
  ExecuteOptions,
  ExecuteResult,
  Executor,
  ResolvedProvider,
} from "@cloudflare/codemode";
import { CapabilityError, safeMessage } from "../gateways/errors";
import type { JsonValue } from "../run/protocol";
import type { CapabilityLimits } from "./execution";
import { toSafeJson } from "./result";

/** What a truncated result or log stream is marked with. Assert on this. */
export const TRUNCATION_MARK = "TRUNCATED";

/**
 * Substrings workerd and the package use for the three failure modes we can
 * name precisely. Matched on the message because that is all that survives:
 * `ToolDispatcher` returns `{ error: err.message }` and the package's own
 * sandbox wrapper does the same, so there is no error class left to inspect.
 */
const CPU_LIMIT_HINTS = [
  "exceeded cpu",
  "cpu time limit",
  "exceeded resource limits",
  "worker exceeded",
];
const IN_SANDBOX_TIMEOUT = "execution timed out";

function classify(message: string): string {
  const lower = message.toLowerCase();
  if (CPU_LIMIT_HINTS.some((hint) => lower.includes(hint))) {
    return `execution_cpu_limit: the sandbox exhausted its CPU budget. Do less work per call, or split it across turns.`;
  }
  if (lower.includes(IN_SANDBOX_TIMEOUT)) {
    return `execution_timeout: the sandbox exceeded its time budget.`;
  }
  // Already one of ours (`code: message`) — leave it alone.
  return message;
}

/**
 * What an exception escaping the race becomes.
 *
 * Deliberately NOT routed through `safeMessage`. That collapses anything
 * unrecognised to an opaque `upstream_unavailable`, which is right for an
 * upstream vendor — its errors carry connection strings — and wrong here: this
 * catch sees the sandbox failing to compile or start MODEL-AUTHORED code. That
 * message is about the model's own program, contains no host credential, and is
 * the only thing that lets the next turn fix a typo instead of retrying blind.
 */
function classifyThrow(err: unknown): string {
  if (err instanceof CapabilityError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  const classified = classify(raw);
  if (classified !== raw) return classified;
  // Everything reaching here failed while compiling, starting, or serialising
  // the result of MODEL-AUTHORED code — provider failures come back through
  // ExecuteResult.error, not as a throw. So the default is invalid_input, not
  // upstream_unavailable: a throwing getter is the model's bug, and telling it
  // "the upstream service failed" sends it debugging the wrong system.
  return `invalid_input: ${raw.slice(0, 500)}`;
}

/* ------------------------------------------------------------- bounding -- */

type BoundedResult =
  | { ok: true; result: JsonValue | string | null; truncated: boolean }
  | { ok: false; error: string };

/**
 * Reduce whatever the sandbox returned to something storable and safe.
 *
 * Two different outcomes, deliberately not conflated: a value that *cannot* be
 * JSON (a cycle, a bigint, a Uint8Array) is an error the model must fix, while
 * a value that is merely *large* is truncated with a marker so the model can
 * see it got a preview and narrow its query.
 */
function boundResult(value: unknown, limits: CapabilityLimits): BoundedResult {
  if (value === undefined) return { ok: true, result: null, truncated: false };

  let safe: JsonValue;
  try {
    // Size is checked below, not here: this pass is only about representability.
    safe = toSafeJson(value, {
      ...limits,
      maxResultChars: Number.MAX_SAFE_INTEGER,
    });
  } catch (err) {
    return { ok: false, error: safeMessage(err) };
  }

  const encoded = JSON.stringify(safe);
  if (encoded === undefined || encoded.length <= limits.maxResultChars) {
    return { ok: true, result: safe, truncated: false };
  }

  // A preview is a string even when the original was an object. Handing back a
  // half-parsed object would be worse: the model would treat it as complete.
  const body = typeof safe === "string" ? safe : encoded;
  const preview = body.slice(0, limits.maxResultChars);
  return {
    ok: true,
    result: `${preview}\n… [${TRUNCATION_MARK}: showing ${preview.length} of ${body.length} characters]`,
    truncated: true,
  };
}

/**
 * Cap console output by total characters, splitting an oversized single line
 * rather than dropping it whole — otherwise `console.log(hugeString)` bypasses
 * the cap entirely by never being counted.
 *
 * This is a CONTEXT-WINDOW bound, not a memory bound. The `__logs` array is
 * built inside the sandbox and crosses the RPC boundary in full before this
 * function ever sees it; nothing host-side can prevent an oversized response.
 */
function boundLogs(
  logs: string[] | undefined,
  limits: CapabilityLimits
): { logs: string[]; truncated: boolean } {
  if (!logs || logs.length === 0) return { logs: [], truncated: false };

  const out: string[] = [];
  let used = 0;
  let truncated = false;

  for (let i = 0; i < logs.length; i += 1) {
    const line = logs[i];
    const remaining = limits.maxConsoleChars - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (line.length <= remaining) {
      out.push(line);
      used += line.length;
      continue;
    }
    out.push(line.slice(0, remaining));
    truncated = true;
    break;
  }

  if (truncated) {
    out.push(
      `… [${TRUNCATION_MARK}: ${logs.length - out.length + 1} of ${logs.length} console lines omitted or cut]`
    );
  }
  return { logs: out, truncated };
}

/* ------------------------------------------------------------- executor -- */

/**
 * Wrap `DynamicWorkerExecutor` so a single execution always terminates and
 * always returns bounded output.
 *
 * Three independent mechanisms bound the run, and none substitutes for another:
 *
 *  1. `limits.cpuMs` on the bundle (Task 4a) — workerd kills a CPU burn, but
 *     only when DEPLOYED. It does not fire under `wrangler dev`, so a local
 *     pass proves nothing about it.
 *  2. the package's `timeout` — compiled INTO the sandbox module as a
 *     `Promise.race` against `setTimeout`. It catches an awaited hang and is
 *     useless against `while (true) {}`, which never yields to that timer.
 *  3. the parent-side race below — the only one that bounds a non-yielding
 *     program in every environment.
 *
 * Never report the parent race's success as evidence that `cpuMs` works.
 *
 * `abortSignal` adds a fourth way for the race to end, and it belongs to ONE
 * execution — which is why an executor is built per `run_code` call rather than
 * once per factory. It reports `execution_timeout` rather than a new code: from
 * model-authored code's point of view the program was abandoned before it
 * finished, which is the same fact whether a clock or the parent decided it.
 * *Why* the parent stopped waiting is the parent's business and stays out of
 * the model-visible error set, which is closed on purpose.
 */
export function makeGuardedExecutor(
  loader: WorkerLoader,
  limits: CapabilityLimits,
  clock: () => number,
  abortSignal?: AbortSignal
): Executor {
  const inner = new DynamicWorkerExecutor({
    loader,
    // Explicit even though it is the package default: `undefined` here means
    // "inherit the parent Worker's full internet access", so the difference
    // between this line and no line is the whole security posture.
    globalOutbound: null,
    timeout: limits.wallTimeMs,
    // No `bindings`, no `modules`. Capabilities cross as call arguments.
  });

  return {
    async execute(
      code: string,
      providersOrFns:
        | ResolvedProvider[]
        | Record<string, (...args: unknown[]) => Promise<unknown>>,
      options?: ExecuteOptions
    ): Promise<ExecuteResult> {
      const startedAt = clock();

      if (code.length > limits.maxCodeChars) {
        return {
          result: null,
          error: new CapabilityError(
            "invalid_input",
            `the program is ${code.length} characters; the cap is ${limits.maxCodeChars}`
          ).message,
        };
      }

      let raw: ExecuteResult;
      try {
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new CapabilityError(
                  "execution_timeout",
                  // "Abandoned" alone is the wrong inference and it cost a
                  // customer two identical messages, twice, in live drills. The
                  // PROGRAM is abandoned; the writes it already made are not,
                  // and cannot be — an external write has left the building the
                  // moment it returns. A model reading only the first clause
                  // concludes nothing happened, redoes the work, and the second
                  // attempt is a genuinely different effect (a reworded message
                  // hashes differently), so the ledger correctly declines to
                  // dedupe it. Naming what survived is what stops the retry.
                  `the program exceeded its ${limits.wallTimeMs}ms budget and was abandoned. IMPORTANT: any capability call that already returned inside it HAS TAKEN EFFECT — a reply was sent, an issue was filed, a pull request was opened. Do not assume the work was lost and redo it. Read back what exists (the thread, the issue, the pull request) and continue from there, and if you retry anything, retry it with the SAME arguments so the effect ledger can recognise it rather than treating a rewrite as a second, new action.`
                )
              ),
            limits.wallTimeMs
          );
        });
        // Swallow the loser. Without this, winning the race leaves a rejected
        // promise nobody awaits, which surfaces as an unhandled rejection and
        // can fail the whole request in workerd.
        timeout.catch(() => {});

        const abandoned = () =>
          new CapabilityError(
            "execution_timeout",
            "the caller stopped waiting for this program, so it was abandoned before it finished."
          );
        const racers: Array<Promise<ExecuteResult>> = [
          inner.execute(code, providersOrFns, options),
          timeout,
        ];
        if (abortSignal !== undefined) {
          const aborted = new Promise<never>((_, reject) => {
            if (abortSignal.aborted) {
              reject(abandoned());
              return;
            }
            abortSignal.addEventListener("abort", () => reject(abandoned()), {
              once: true,
            });
          });
          aborted.catch(() => {}); // same reason as `timeout.catch` above
          racers.push(aborted);
        }

        raw = await Promise.race(racers);
      } catch (err) {
        // The Executor contract says implementations never throw. Everything
        // that escapes the race becomes a value here.
        return {
          result: null,
          error: classifyThrow(err),
          logs: [],
        };
      }

      const bounded = boundLogs(raw.logs, limits);

      if (raw.error !== undefined) {
        return { result: null, error: classify(raw.error), logs: bounded.logs };
      }

      const value = boundResult(raw.result, limits);
      if (!value.ok) {
        return { result: null, error: value.error, logs: bounded.logs };
      }

      void startedAt; // duration is recorded by the caller's audit sink
      return { result: value.result, logs: bounded.logs };
    },
  };
}
