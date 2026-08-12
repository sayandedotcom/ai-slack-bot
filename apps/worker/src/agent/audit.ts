import type { JsonObject, JsonValue, ToolCallUpdateInput } from "../run/protocol";
import type {
  CapabilityAuditSink,
  CapabilityEvent,
  CapabilityFailed,
  CapabilityStarted,
} from "../codemode/contracts";
import type { CodeExecutionContext, CodeModeOutput } from "../codemode/tool";

/**
 * How one `run_code` call and its nested capability calls become RunEvents.
 *
 * Everything here maps onto the EXISTING `tool_call` event family (invariant
 * 19, and the streaming-protocol rule that says map, do not invent). There is
 * no `code_mode_update` type and there must not be: a parallel event type would
 * not replay through the existing `since` cursor, every client would need to
 * learn it, and the dashboard's tool timeline would silently omit the only tool
 * this agent has.
 *
 * THE PAYLOAD RULE, which is the reason this module exists rather than a few
 * inline object literals at the call site. A Code Mode result is model-authored
 * output of arbitrary size — a full Slack thread, a trace dump, a table of
 * rows. It goes to the model as its tool result, through the AI SDK, complete
 * and untruncated. It does NOT go into the event stream: RunDO events are
 * durable, replayed to every attached socket on reconnect, and projected to D1.
 * What lands there is a bounded flat preview plus the facts an operator
 * actually reads — state, duration, capability count, truncation flags, log
 * volume. Those are different jobs and this file is where they stop being
 * confused.
 */

/* -------------------------------------------------------------- bounding -- */

/** Reviewed constants. Nothing a model writes and no request may raise them. */
export const EVENT_PREVIEW_CHARS = 800;
export const EVENT_ERROR_CHARS = 600;
export const EVENT_LOG_PREVIEW_CHARS = 800;
export const EVENT_LOG_LINES = 5;
export const EVENT_ARG_CHARS = 400;
export const EVENT_CODE_PREVIEW_CHARS = 600;

/** Appended where a value was cut, so a reader never mistakes a preview for the whole. */
export const PREVIEW_ELLIPSIS = "…";

export function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}${PREVIEW_ELLIPSIS}`;
}

/**
 * Flatten any value to a bounded single string.
 *
 * FLAT, deliberately. `JsonValue` bottoms out after four levels, so a nested
 * preview can fail to typecheck in a way no test observes — and a preview whose
 * shape varies with the result is a preview no client can render. One string
 * always, with its original size reported beside it.
 */
export function flatPreview(
  value: unknown,
  limit = EVENT_PREVIEW_CHARS,
): { preview: string; chars: number; truncated: boolean } {
  let encoded: string;
  if (typeof value === "string") {
    encoded = value;
  } else {
    try {
      encoded = JSON.stringify(value) ?? String(value);
    } catch {
      encoded = "[unserializable]";
    }
  }
  return {
    preview: boundedText(encoded, limit),
    chars: encoded.length,
    truncated: encoded.length > limit,
  };
}

/* ------------------------------------------------------- the outer tool -- */

/**
 * Identity of one outer `run_code` update.
 *
 * `tool_updates.id` is a primary key, so a redelivered alarm re-running the
 * same step must produce the same id or the timeline grows a duplicate. The
 * generation is in the string because a provider `toolCallId` is only unique
 * within one provider request, and a crash-retry of the same generation issues
 * a fresh one.
 *
 * Note what this is NOT used for: D1 effect rows. Those key on the stable
 * `agent_turn_id` (invariant 7), because a retry must replay the SAME effect
 * rather than perform a second one — and `toolCallId` changes across a retry by
 * design. Two identity schemes, two different jobs, and confusing them means a
 * customer gets two messages.
 */
export function outerToolUpdateId(
  generationId: string,
  toolCallId: string,
  phase: "start" | "end",
): string {
  return `tool:${generationId}:${toolCallId}:${phase}`;
}

export function nestedToolUpdateId(
  generationId: string,
  callId: string,
  phase: "start" | "end",
): string {
  return `tool:${generationId}:${callId}:${phase}`;
}

export type OuterToolMapper = {
  started(input: { toolCallId: string; code: string }): ToolCallUpdateInput;
  ended(input: { toolCallId: string; output: CodeModeOutput }): ToolCallUpdateInput;
};

/**
 * The outer lifecycle, mapped ONCE.
 *
 * One start and one end per `run_code` call — the plan is explicit that a
 * caller uses `onToolExecutionStart`/`onToolExecutionEnd` OR an equivalent
 * wrapper, never both, because both means every tool call appears twice in the
 * timeline and the second `completed` overwrites the first's output.
 */
export function outerToolMapper(generationId: string): OuterToolMapper {
  return {
    started({ toolCallId, code }): ToolCallUpdateInput {
      const preview = flatPreview(code, EVENT_CODE_PREVIEW_CHARS);
      return {
        id: outerToolUpdateId(generationId, toolCallId, "start"),
        callId: toolCallId,
        name: "run_code",
        state: "running",
        // A bounded preview and the real size. The full program is already in
        // the model's own message history; duplicating up to 24KB of it into
        // every socket replay buys nothing and costs every reconnect.
        input: {
          codePreview: preview.preview,
          codeChars: preview.chars,
          codeTruncated: preview.truncated,
        },
      };
    },

    ended({ toolCallId, output }): ToolCallUpdateInput {
      const failed = output.error !== undefined;
      const result = flatPreview(output.result);
      const logs = output.logs ?? [];
      const logPreview = flatPreview(
        logs.slice(0, EVENT_LOG_LINES).join("\n"),
        EVENT_LOG_PREVIEW_CHARS,
      );

      const summary: JsonObject = {
        durationMs: output.metrics.durationMs,
        capabilityCalls: output.metrics.capabilityCalls,
        logLines: logs.length,
        logPreview: logPreview.preview,
        // Two different truncations, kept apart. `resultTruncated` means the
        // EVENT shows less than the model received; `executorTruncated` means
        // the executor itself cut the value before the model ever saw it.
        resultChars: result.chars,
        resultTruncated: result.truncated,
        executorTruncatedResult: output.truncation.result,
        executorTruncatedLogs: output.truncation.logs,
      };

      return {
        id: outerToolUpdateId(generationId, toolCallId, "end"),
        callId: toolCallId,
        name: "run_code",
        // `CodeModeOutput.error` makes this event FAILED even though the AI SDK
        // correctly receives that error as a normal tool result: the model is
        // meant to read the error and adapt, while an operator watching the
        // timeline is meant to see that the step did not do what it set out to.
        // Both are true at once, and only one of them is an event state.
        state: failed ? "failed" : "completed",
        output: failed ? summary : { ...summary, resultPreview: result.preview },
        ...(failed
          ? { error: boundedText(output.error as string, EVENT_ERROR_CHARS) }
          : {}),
      };
    },
  };
}

/* ------------------------------------------------ nested capability calls -- */

/**
 * Redact and bound capability arguments for the event stream.
 *
 * `withCapabilityAudit` has already dropped credential-shaped fields. This
 * bounds what survives: a 500-character memory query or a 4000-character Slack
 * reply is legitimate input and useless in a timeline, and it is durable.
 */
export function boundedArgs(args: JsonObject | null): JsonValue {
  if (args === null) return null;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      out[key] = boundedText(value, EVENT_ARG_CHARS);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      // Scalars are already bounded and already meaningful; a `limit: 10` is
      // more useful in a timeline as a number than as the string "10".
      out[key] = value;
    } else {
      // Arrays and objects collapse to one bounded string. A nested preview
      // would ride against `JsonValue`'s depth bound, which is a typecheck
      // failure no test can observe.
      out[key] = flatPreview(value, EVENT_ARG_CHARS).preview;
    }
  }
  return out as JsonValue;
}

/**
 * Map one nested capability event onto a tool-call update.
 *
 * The call id is the one Task 1 built — `cap:{outerToolCallId}:{seq}` — and it
 * already carries the outer call, which is what makes an audit trail
 * reconstructable when one agent loop has issued ten `run_code` calls that each
 * start their sequence at 1.
 *
 * The visible NAME is `namespace.method`. That is the whole reason nested
 * events are worth emitting: the model has one tool, so a timeline of
 * `run_code, run_code, run_code` says nothing, while `slack.thread`,
 * `memory.recall`, `linear.createIssue` is the actual story of what the agent
 * did — and `linear.createIssue` is a line a human may need to find later.
 */
export function nestedToolUpdate(
  generationId: string,
  event: CapabilityEvent,
): ToolCallUpdateInput {
  const name = `${event.namespace}.${event.method}`;

  if (event.kind === "started") {
    const started = event as CapabilityStarted;
    return {
      id: nestedToolUpdateId(generationId, event.callId, "start"),
      callId: event.callId,
      name,
      state: "running",
      input: boundedArgs(started.args),
      createdAt: event.at,
    };
  }

  if (event.kind === "completed") {
    return {
      id: nestedToolUpdateId(generationId, event.callId, "end"),
      callId: event.callId,
      name,
      state: "completed",
      // Size, never content. A capability result can be an entire customer
      // conversation; the model needs it, the event stream does not.
      output: { durationMs: event.durationMs, resultChars: event.resultChars },
      createdAt: event.at + event.durationMs,
    };
  }

  const failure = event as CapabilityFailed;
  return {
    id: nestedToolUpdateId(generationId, event.callId, "end"),
    callId: event.callId,
    name,
    state: "failed",
    output: { durationMs: failure.durationMs, retryable: failure.retryable },
    // Already the safe `code: message` wire form — `CapabilityError` cannot be
    // constructed without its code, and an untranslated host throw was
    // collapsed to `upstream_unavailable` before it got here.
    error: boundedText(failure.message, EVENT_ERROR_CHARS),
    createdAt: failure.at + failure.durationMs,
  };
}

/* ------------------------------------------------------------------ sink -- */

/**
 * Where a nested update is written. A port, not a RunDO import: this module
 * must stay testable without a Durable Object, and Task 7 supplies the
 * claim-fenced `appendAgentToolCallUpdate` implementation.
 */
export interface ToolUpdateWriter {
  write(update: ToolCallUpdateInput): Promise<void>;
}

/**
 * One audit sink per `run_code` execution, which is what
 * `MakeRunCodeToolInput.auditForExecution` asks for.
 *
 * Per execution rather than per tool because the sink is how a nested event
 * finds the `run_code` call it belongs to. A single shared sink cannot say
 * which of an agent loop's ten tool calls an event came from — and by the time
 * that matters, somebody is reading the log because something went wrong.
 */
export function auditSinkFactory(
  generationId: string,
  writer: ToolUpdateWriter,
): (context: CodeExecutionContext) => CapabilityAuditSink {
  const emit = async (event: CapabilityEvent): Promise<void> => {
    await writer.write(nestedToolUpdate(generationId, event));
  };
  return () => ({
    started: emit,
    completed: emit,
    failed: emit,
  });
}
