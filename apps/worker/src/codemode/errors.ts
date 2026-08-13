import type { JsonObject } from "../run/protocol";

/**
 * The closed set of failures a capability may report to model-authored code.
 *
 * Closed on purpose. The model has to branch on these, and a code it has never
 * seen is indistinguishable from a bug. Adding one is a deliberate change to
 * the model-visible contract, not an implementation detail.
 */
export type CapabilityErrorCode =
  | "invalid_context"
  | "invalid_input"
  | "capability_unavailable"
  | "channel_read_only"
  | "slack_context_required"
  | "identity_unavailable"
  | "shadow_write_denied"
  | "linear_team_denied"
  | "customer_scope_required"
  | "read_only_violation"
  | "stale_generation"
  | "effect_in_doubt"
  | "output_too_large"
  | "execution_timeout"
  | "execution_cpu_limit"
  | "upstream_unavailable"
  | "approval_already_open"
  | "approval_not_open";

/**
 * Codes where trying the same call again could plausibly succeed.
 *
 * Deliberately tiny. `effect_in_doubt` is the one that matters: it means a
 * write may or may not have landed, so a retry risks doing it twice. Marking
 * it retryable would turn "we are not sure" into "send it again", which is the
 * exact failure the effect ledger exists to prevent.
 */
const RETRYABLE: ReadonlySet<CapabilityErrorCode> = new Set([
  "upstream_unavailable",
]);

/**
 * What model-authored code is told when the run it belongs to has moved on.
 *
 * Deliberately says nothing about *what* the newer input is. The steer text is
 * the next step's business: putting it here would smuggle unreviewed user
 * content into an error string that also reaches the audit log, and would
 * invite the model to act on a message it was never formally handed.
 *
 * Not retryable. Repeating the same call cannot make this run current again;
 * the only useful move is to stop and let the next step start.
 */
export const STALE_GENERATION_MESSAGE =
  "newer input arrived for this run, so this execution is no longer current. Stop here rather than retrying; the next step receives the newer input.";

/**
 * What an untranslated host failure becomes on its way to the model.
 *
 * Fixed text, never the upstream message: upstream errors routinely carry
 * connection strings, bearer tokens and stack frames, and every one of those
 * would otherwise be handed to model-authored code verbatim.
 */
const OPAQUE_UPSTREAM =
  "The upstream service failed. Nothing was retried automatically; try again or use a different capability.";

/**
 * A failure that is safe to show model-authored code.
 *
 * `message` is *already* the wire format — `"code: reason"` — because only
 * `message` survives the isolate boundary. `@cloudflare/codemode` catches host
 * errors in `ToolDispatcher` and returns `{ error: err.message }`; the sandbox
 * then rethrows `new Error(data.error)`. `code`, `retryable` and `details`
 * reach the audit sink but never reach the model, so building the prefix into
 * `message` at construction is what makes the code recoverable at all. There
 * is deliberately no way to construct one whose message omits its code.
 */
export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  /** The reason without the `code: ` prefix, for audit records. */
  readonly reason: string;

  constructor(
    code: CapabilityErrorCode,
    reason: string,
    options?: { retryable?: boolean; details?: JsonObject },
  ) {
    super(`${code}: ${reason}`);
    this.name = "CapabilityError";
    this.code = code;
    this.reason = reason;
    this.retryable = options?.retryable ?? RETRYABLE.has(code);
    this.details = options?.details;
  }
}

/**
 * The one function that decides what model-authored code learns about a
 * failure. Anything not already a CapabilityError is collapsed to a single
 * opaque code: an adapter that forgets to translate must not be the reason a
 * connection string reaches the model.
 */
export function safeMessage(err: unknown): string {
  if (err instanceof CapabilityError) return err.message;
  return `upstream_unavailable: ${OPAQUE_UPSTREAM}`;
}

/**
 * Narrow an arbitrary throw to a CapabilityError, preserving one that is
 * already safe. Used at every boundary that can rethrow toward the sandbox.
 */
export function toCapabilityError(err: unknown): CapabilityError {
  if (err instanceof CapabilityError) return err;
  return new CapabilityError("upstream_unavailable", OPAQUE_UPSTREAM);
}
