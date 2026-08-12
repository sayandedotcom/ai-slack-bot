import type {
  AssistantModelMessage,
  ModelMessage,
  PrepareStepFunction,
  ToolModelMessage,
  ToolResultPart,
  ToolSet,
} from "ai";

/**
 * `ai@7` declares `ResponseMessage` but does not export it, so it is DERIVED
 * from a type that is exported rather than hand-copied.
 *
 * A local `type ResponseMessage = AssistantModelMessage | ToolModelMessage`
 * would compile forever, including after the SDK added a third member — and the
 * allowlist below would then be filtering a shape it no longer describes,
 * silently. Deriving it means that change breaks this build instead.
 */
export type ResponseMessage =
  Parameters<PrepareStepFunction<ToolSet>>[0]["responseMessages"][number];

/**
 * The provider-continuation view of a run: how a step's response messages become
 * durable rows, and how those rows become a legal next request.
 *
 * `RunTurn` is the human/audit view and is NOT interchangeable with this. A
 * step's assistant tool-call message and its tool-result message have no turn
 * representation at all, and losing them makes a continuation re-issue a tool
 * call the model already made (invariant 16).
 *
 * Nothing here imports the run layer's `JsonValue`. That type is depth-bounded
 * for RPC reasons and provider payloads are not; casting one to the other would
 * be a lie that typechecks. Transcript rows are stored as `unknown` and
 * serialized with `JSON.stringify`, so the bounded type is never involved.
 */

/** The only tool that exists (invariant 5). Anything else is a malformed step. */
export const OUTER_TOOL_NAME = "run_code";

/**
 * The one namespace whose reasoning metadata we replay, spelled once.
 * `@ai-sdk/anthropic` reads `providerOptions.anthropic.signature` /
 * `.redactedData` when it rebuilds a `thinking` / `redacted_thinking` block.
 */
const ANTHROPIC = "anthropic";

/** A part the allowlist declined to carry, recorded rather than silently lost. */
export type DroppedPart = {
  messageIndex: number;
  partIndex: number;
  /** The part's own `type`, or `unknown` for something unrecognisable. */
  partType: string;
  reason:
    | "unsupported_part"
    | "reasoning_without_signature"
    | "provider_executed_result"
    | "empty_message";
};

export type NormalizeRejection =
  /**
   * Readable chain-of-thought arrived despite `display: "omitted"`. Fail safe:
   * the step is refused, and the signed block is neither mutated nor replayed
   * (invariant 17). Do NOT "fix" this by blanking the text — a provider that
   * ignored the display option is a provider whose signature we cannot reason
   * about either.
   */
  | "readable_reasoning"
  /** A tool call naming something other than `run_code`. */
  | "unsupported_tool"
  /** A provider-executed tool call. None are enabled; one appearing is not ours. */
  | "provider_executed_tool"
  /** A tool result whose output cannot be represented as JSON. */
  | "unserializable_tool_output";

export type NormalizeOutcome =
  | { outcome: "normalized"; messages: ResponseMessage[]; dropped: DroppedPart[] }
  | { outcome: "rejected"; reason: NormalizeRejection; detail: string };

/**
 * The strict allowlist for AI SDK `ResponseMessage` parts.
 *
 * Allowlist, not denylist, and rebuilt field by field rather than filtered in
 * place. A denylist is wrong here twice over: the SDK can add a part type in a
 * minor release, and a passed-through object can carry fields nobody enumerated
 * — which is how a raw provider body, or readable reasoning, ends up in a
 * durable row that later reaches a log.
 *
 * KEPT:
 *  - assistant text;
 *  - the Fable omitted-thinking block, with its opaque `signature` OR
 *    `redactedData`, byte-for-byte;
 *  - `run_code` tool calls;
 *  - the matching tool results and tool errors.
 *
 * Everything else is dropped and recorded, except the four conditions above that
 * mean the step itself is not safe to keep, which reject.
 */
export function normalizeResponseMessages(messages: readonly ResponseMessage[]): NormalizeOutcome {
  const out: ResponseMessage[] = [];
  const dropped: DroppedPart[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "assistant") {
      const result = normalizeAssistant(message, messageIndex, dropped);
      if (result.outcome === "rejected") return result;
      if (result.message) out.push(result.message);
      continue;
    }
    if (message.role === "tool") {
      const result = normalizeTool(message, messageIndex, dropped);
      if (result.outcome === "rejected") return result;
      if (result.message) out.push(result.message);
      continue;
    }
    // `ResponseMessage` is `AssistantModelMessage | ToolModelMessage`, so this is
    // unreachable through the type. It is here because the value crossing this
    // boundary comes from the provider at runtime, and an unexpected role must
    // not be forwarded on the strength of a type declaration.
    dropped.push({
      messageIndex,
      partIndex: -1,
      partType: String((message as { role?: unknown }).role ?? "unknown"),
      reason: "unsupported_part",
    });
  }

  return { outcome: "normalized", messages: out, dropped };
}

type MessageResult<T> =
  | { outcome: "ok"; message: T | null }
  | { outcome: "rejected"; reason: NormalizeRejection; detail: string };

function normalizeAssistant(
  message: AssistantModelMessage,
  messageIndex: number,
  dropped: DroppedPart[],
): MessageResult<AssistantModelMessage> {
  // `AssistantContent` may be a bare string. Canonicalised to a part array so
  // every stored assistant message has one shape to read back.
  //
  // The `Array.isArray` fallback is not dead code dressed as caution: this value
  // arrives from the provider at runtime, and the declared type is a claim about
  // it rather than a guarantee. Anything that is neither a string nor an array
  // yields no parts, so the message is dropped as empty rather than crashing a
  // checkpoint that has already been billed for.
  const parts = typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : Array.isArray(message.content)
      ? message.content
      : [];

  const kept: AssistantModelMessage["content"] = [];

  for (const [partIndex, part] of parts.entries()) {
    const type = (part as { type?: unknown }).type;

    if (type === "text") {
      const text = (part as { text: string }).text;
      // Rebuilt with exactly two fields. Anthropic can attach citation metadata
      // to a text block; none of it is needed to continue, and carrying it would
      // mean carrying whatever else shares that bag.
      kept.push({ type: "text", text });
      continue;
    }

    if (type === "reasoning") {
      const reasoning = part as { text: string; providerOptions?: unknown };
      if (typeof reasoning.text === "string" && reasoning.text.length > 0) {
        return {
          outcome: "rejected",
          reason: "readable_reasoning",
          detail: `message ${messageIndex} part ${partIndex} carries ${reasoning.text.length} characters of readable reasoning`,
        };
      }
      const opaque = readOmittedThinking(reasoning.providerOptions);
      if (!opaque) {
        // An empty thinking block with no signature and no redacted data cannot
        // be sent back — `@ai-sdk/anthropic` would warn "unsupported reasoning
        // metadata" and emit nothing. Dropping it is the only honest option, and
        // it is recorded so a run that hits this is visible.
        dropped.push({ messageIndex, partIndex, partType: "reasoning", reason: "reasoning_without_signature" });
        continue;
      }
      // UNMODIFIED. The empty text and the opaque value are exactly what came
      // back; the provider validates the signature against the block it signed,
      // so re-encoding, trimming or re-casing any of it invalidates the turn.
      kept.push({ type: "reasoning", text: "", providerOptions: { [ANTHROPIC]: opaque } });
      continue;
    }

    if (type === "tool-call") {
      const call = part as {
        toolCallId: string;
        toolName: string;
        input: unknown;
        providerExecuted?: boolean;
        providerOptions?: unknown;
      };
      if (call.providerExecuted === true) {
        return {
          outcome: "rejected",
          reason: "provider_executed_tool",
          detail: `message ${messageIndex} part ${partIndex} is a provider-executed call to ${call.toolName}`,
        };
      }
      if (call.toolName !== OUTER_TOOL_NAME) {
        // Exactly one tool is offered. A different name means either the request
        // was not the one we built or the response is not for us; either way it
        // must not become durable history.
        return {
          outcome: "rejected",
          reason: "unsupported_tool",
          detail: `message ${messageIndex} part ${partIndex} calls ${call.toolName}, not ${OUTER_TOOL_NAME}`,
        };
      }
      if (!isJsonLike(call.input)) {
        return {
          outcome: "rejected",
          reason: "unserializable_tool_output",
          detail: `message ${messageIndex} part ${partIndex} has tool input that is not JSON`,
        };
      }
      // Exactly four fields, and NO `providerOptions`.
      //
      // This used to forward the provider bag whole if it merely looked like
      // JSON, which contradicted this module's own rule two screens up: a
      // passed-through object carries fields nobody enumerated, and that is how
      // a raw provider body or readable reasoning reaches a durable row. A
      // future `@ai-sdk/anthropic` attaching metadata to a tool-use part would
      // have been persisted verbatim into `model_messages`.
      //
      // Anthropic needs nothing beyond id, name and input to replay a
      // `tool_use` block, so dropping the bag costs no continuation fidelity.
      // Contrast the reasoning part above, which keeps exactly ONE named key
      // because the provider genuinely requires it.
      kept.push({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
      continue;
    }

    if (type === "tool-result") {
      // Only provider-executed tools put results in an assistant message, and
      // none are enabled. The matching call was already refused above, so this
      // is unreachable in practice; dropped rather than rejected so that a
      // future provider-side tool cannot break an otherwise fine step.
      dropped.push({ messageIndex, partIndex, partType: "tool-result", reason: "provider_executed_result" });
      continue;
    }

    // `file`, `reasoning-file`, `custom`, `tool-approval-request`, and anything
    // the SDK adds next. Safely handled by not carrying them: none is needed to
    // continue a `run_code` turn, and a file part in particular can hold bytes
    // we have no policy for.
    dropped.push({
      messageIndex,
      partIndex,
      partType: typeof type === "string" ? type : "unknown",
      reason: "unsupported_part",
    });
  }

  if (kept.length === 0) {
    dropped.push({ messageIndex, partIndex: -1, partType: "assistant", reason: "empty_message" });
    return { outcome: "ok", message: null };
  }
  return { outcome: "ok", message: { role: "assistant", content: kept } };
}

function normalizeTool(
  message: ToolModelMessage,
  messageIndex: number,
  dropped: DroppedPart[],
): MessageResult<ToolModelMessage> {
  const kept: ToolModelMessage["content"] = [];
  const parts = Array.isArray(message.content) ? message.content : [];

  for (const [partIndex, part] of parts.entries()) {
    const type = (part as { type?: unknown }).type;

    if (type !== "tool-result") {
      // `tool-approval-response`. Phase 11 owns approvals; nothing in this build
      // produces one, and replaying an approval we never granted is not a thing
      // to do quietly.
      dropped.push({
        messageIndex,
        partIndex,
        partType: typeof type === "string" ? type : "unknown",
        reason: "unsupported_part",
      });
      continue;
    }

    const result = part as { toolCallId: string; toolName: string; output: unknown };
    const output = normalizeToolOutput(result.output);
    if (output === null) {
      return {
        outcome: "rejected",
        reason: "unserializable_tool_output",
        detail: `message ${messageIndex} part ${partIndex} has a tool output that cannot be stored`,
      };
    }
    kept.push({
      type: "tool-result",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      output,
    });
  }

  if (kept.length === 0) {
    dropped.push({ messageIndex, partIndex: -1, partType: "tool", reason: "empty_message" });
    return { outcome: "ok", message: null };
  }
  return { outcome: "ok", message: { role: "tool", content: kept } };
}

/** The `ToolResultOutput` shapes we carry, rebuilt. Null means "cannot store this". */
function normalizeToolOutput(output: unknown): ToolResultPart["output"] | null {
  if (typeof output !== "object" || output === null) return null;
  const value = output as { type?: unknown; value?: unknown; reason?: unknown };

  switch (value.type) {
    case "text":
    case "error-text":
      return typeof value.value === "string" ? { type: value.type, value: value.value } : null;
    case "json":
    case "error-json":
      // `value` is checked structurally and handed on as the SDK's own JSON
      // type. It is deliberately NOT cast to the run layer's depth-bounded
      // `JsonValue`: a `run_code` result is already size-capped by Phase 09, and
      // pretending it fits a four-level type would be a lie the compiler cannot
      // catch.
      return isJsonLike(value.value)
        ? ({ type: value.type, value: value.value } as ToolResultPart["output"])
        : null;
    case "execution-denied":
      return {
        type: "execution-denied",
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      };
    case "content":
      // Multi-modal tool output. Nothing this build produces returns one, and
      // carrying image bytes into durable history has no reviewed policy.
      return null;
    default:
      return null;
  }
}

/**
 * The opaque continuation metadata for one omitted-thinking block, or null.
 *
 * Reads ONLY the two keys `@ai-sdk/anthropic` reads back, and copies the string
 * by reference so the bytes are identical. Note it never copies the whole
 * `anthropic` bag: that bag can also carry cache-control and usage detail, and a
 * thinking block explicitly cannot be cached.
 */
export function readOmittedThinking(
  providerOptions: unknown,
): { signature: string } | { redactedData: string } | null {
  if (typeof providerOptions !== "object" || providerOptions === null) return null;
  const anthropic = (providerOptions as Record<string, unknown>)[ANTHROPIC];
  if (typeof anthropic !== "object" || anthropic === null) return null;

  const record = anthropic as Record<string, unknown>;
  if (typeof record.signature === "string" && record.signature.length > 0) {
    return { signature: record.signature };
  }
  if (typeof record.redactedData === "string" && record.redactedData.length > 0) {
    return { redactedData: record.redactedData };
  }
  return null;
}

/**
 * Structural JSON check. Rejects functions, symbols, undefined, non-finite
 * numbers, cycles, and class instances — the same refusal-over-coercion posture
 * as Phase 09's `toSafeJson`, minus its depth bound, because a provider payload
 * is not going into the depth-bounded RPC type.
 */
function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return false;
  }

  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  try {
    if (Array.isArray(object)) return object.every((item) => isJsonLike(item, seen));
    const proto = Object.getPrototypeOf(object) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(object).every((item) => isJsonLike(item, seen));
  } finally {
    seen.delete(object);
  }
}

// --- bounded history selection ----------------------------------------------

/** One durable transcript row, as the pruner sees it. */
export type TranscriptMessage = {
  ordinal: number;
  generationId: string;
  message: ModelMessage;
};

export type HistoryBounds = {
  maxMessages: number;
  maxBytes: number;
  /**
   * The generation currently being answered. Every one of its messages is
   * protected: they are the unsettled work, and pruning them would make the
   * model re-derive what it just did, or worse, re-issue an effect.
   */
  protectedGenerationId?: string;
};

export type HistorySelection =
  | {
      outcome: "selected";
      messages: ModelMessage[];
      bytes: number;
      /** How many atomic exchanges were evicted from the front. */
      droppedGroups: number;
      /**
       * Tool calls in the FINAL group that have no tool result.
       *
       * This is an OBLIGATION ON THE CALLER, not a diagnostic, which is why it
       * is in the type rather than in a comment. A transcript can legitimately
       * end this way — a crash between issuing a tool call and checkpointing its
       * result — and nothing here fabricates a result to repair it, because the
       * plan forbids that outright. But Anthropic rejects a request whose last
       * assistant block is an unanswered `tool_use`, so the driver must either
       * re-execute these calls and checkpoint their results, or drop the
       * trailing assistant message, BEFORE sending.
       *
       * An array rather than the single id that `disableParallelToolUse: true`
       * should guarantee: the guarantee is the provider's, and a selection
       * function that silently reports one of two unresolved calls would hide
       * exactly the case where that guarantee failed.
       */
      unresolvedTailCallIds: string[];
    }
  | {
      outcome: "context_limit";
      reason:
        | "protected_exceeds_budget"
        | "unpaired_tool_call"
        /** Nothing that fits opens on a `user` message, which Anthropic requires. */
        | "no_user_boundary";
      detail: string;
    };

/**
 * One atomic exchange: a message and everything that must travel with it.
 *
 * The unit of eviction is the GROUP, never the message. An assistant tool call
 * and its tool result are one indivisible thing to Anthropic — send the result
 * without the call and the request is malformed; send the call without the
 * result and the SDK raises `MissingToolResultsError` before a byte leaves. The
 * Fable thinking block needs no separate rule because it is a part INSIDE the
 * assistant message that made the call, so it cannot be separated from it by
 * construction.
 */
type Group = {
  entries: TranscriptMessage[];
  protected: boolean;
};

/**
 * Choose the bounded history to send.
 *
 * Evicts whole groups from the OLDEST end until the selection fits. Returns
 * `context_limit` rather than a malformed request when no safe boundary exists —
 * a refusal the driver can report is recoverable; a 400 from Anthropic after
 * paying for the input tokens is not (plan: "if a safe boundary cannot fit, stop
 * with `context_limit` rather than send malformed history").
 *
 * System policy is NOT part of this budget and cannot be pruned by it: it lives
 * in `instructions`, not in `messages`. That is deliberate — a pruner that could
 * reach the policy is a pruner that can silently disable the injection rules.
 */
export function selectModelHistory(
  entries: readonly TranscriptMessage[],
  bounds: HistoryBounds,
): HistorySelection {
  const groups = groupTranscript(entries);
  if (groups.outcome === "malformed") {
    return { outcome: "context_limit", reason: "unpaired_tool_call", detail: groups.detail };
  }

  const all = groups.groups;
  // An empty transcript is a legal state — the very first step of a run has
  // nothing but the input messages the caller is about to add — and it must read
  // as "nothing to send", never as a context failure.
  if (all.length === 0) {
    return {
      outcome: "selected",
      messages: [],
      bytes: 2,
      droppedGroups: 0,
      unresolvedTailCallIds: [],
    };
  }
  markProtected(all, bounds.protectedGenerationId);
  // The newest group is always protected even when no generation id is supplied:
  // it is the current unsettled exchange by position, and a bound low enough to
  // evict it would send an empty conversation.
  if (all.length > 0) all[all.length - 1].protected = true;

  let start = 0;
  while (start < all.length) {
    const window = all.slice(start);
    const messages = window.flatMap((group) => group.entries.map((entry) => entry.message));
    const bytes = encodedBytes(messages);
    const fits = messages.length <= bounds.maxMessages && bytes <= bounds.maxBytes;
    // The Anthropic Messages API requires the FIRST message to be `user`.
    //
    // Group boundaries alone do not give this. An ordinary multi-step
    // generation is `[user][assistant+tool][assistant+tool][assistant+tool]`,
    // and evicting only the oldest group there leaves a window that opens on an
    // assistant message — structurally well-paired, and rejected with a 400
    // before a token is generated. So a window that fits but does not open on a
    // user message is not a boundary; keep evicting.
    const opensOnUser = messages.length === 0 || messages[0].role === "user";

    if (fits && opensOnUser) {
      const paired = assertPairing(window);
      if (!paired.ok) {
        return { outcome: "context_limit", reason: "unpaired_tool_call", detail: paired.detail };
      }
      return {
        outcome: "selected",
        messages,
        bytes,
        droppedGroups: start,
        unresolvedTailCallIds: unresolvedTailCalls(window),
      };
    }

    if (all[start].protected) {
      // Everything left is protected. Whichever condition failed cannot be
      // fixed by evicting more, because the next thing to evict is unsettled
      // work — so refuse rather than send something Anthropic will reject.
      return fits
        ? {
            outcome: "context_limit",
            reason: "no_user_boundary",
            detail: `the unsettled history opens on a ${messages[0]?.role ?? "empty"} message; no user turn survives the ${bounds.maxMessages} / ${bounds.maxBytes} bound`,
          }
        : {
            outcome: "context_limit",
            reason: "protected_exceeds_budget",
            detail: `${messages.length} messages / ${bytes} bytes of unsettled history exceed the ${bounds.maxMessages} / ${bounds.maxBytes} bound`,
          };
    }
    start += 1;
  }

  return {
    outcome: "context_limit",
    reason: "protected_exceeds_budget",
    detail: "no group could be retained within the bound",
  };
}

type GroupingOutcome =
  | { outcome: "grouped"; groups: Group[] }
  | { outcome: "malformed"; detail: string };

function groupTranscript(entries: readonly TranscriptMessage[]): GroupingOutcome {
  const groups: Group[] = [];
  for (const entry of entries) {
    if (entry.message.role === "tool") {
      const current = groups[groups.length - 1];
      if (!current) {
        // A tool result with no assistant message before it anywhere. Nothing
        // this side wrote could produce that, and it cannot be repaired without
        // fabricating the call — which the plan forbids outright.
        return {
          outcome: "malformed",
          detail: `transcript ordinal ${entry.ordinal} is a tool result with no preceding assistant message`,
        };
      }
      current.entries.push(entry);
      continue;
    }
    groups.push({ entries: [entry], protected: false });
  }
  return { outcome: "grouped", groups };
}

function markProtected(groups: Group[], protectedGenerationId: string | undefined): void {
  if (!protectedGenerationId) return;
  for (const group of groups) {
    if (group.entries.some((entry) => entry.generationId === protectedGenerationId)) {
      group.protected = true;
    }
  }
}

/**
 * The unanswered tool calls in the final group — the exemption `assertPairing`
 * grants, made visible to the caller instead of left implicit.
 *
 * `assertPairing` deliberately allows the tail to hold an unresolved call,
 * because that is a real crash-recovery state rather than a malformed history.
 * This reports exactly what that exemption let through, so the driver cannot
 * receive a `selected` result and assume it is ready to send.
 */
function unresolvedTailCalls(groups: readonly Group[]): string[] {
  const last = groups[groups.length - 1];
  if (!last) return [];

  const calls: string[] = [];
  const results = new Set<string>();
  for (const entry of last.entries) {
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call") calls.push(part.toolCallId);
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") results.add(part.toolCallId);
      }
    }
  }
  return calls.filter((id) => !results.has(id));
}

/**
 * Every tool result in the window must have its call in the window, and every
 * call must have its result unless it sits in the final (unsettled) group.
 */
function assertPairing(groups: readonly Group[]): { ok: true } | { ok: false; detail: string } {
  for (const [index, group] of groups.entries()) {
    const isLast = index === groups.length - 1;
    const groupCalls = new Set<string>();
    const groupResults = new Set<string>();

    for (const entry of group.entries) {
      const message = entry.message;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call") groupCalls.add(part.toolCallId);
        }
      }
      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result") groupResults.add(part.toolCallId);
        }
      }
    }

    for (const id of groupResults) {
      if (!groupCalls.has(id)) {
        return { ok: false, detail: `tool result ${id} has no tool call in the selected history` };
      }
    }
    for (const id of groupCalls) {
      if (!groupResults.has(id) && !isLast) {
        return { ok: false, detail: `tool call ${id} has no tool result in the selected history` };
      }
    }
  }
  return { ok: true };
}

function encodedBytes(messages: readonly ModelMessage[]): number {
  return JSON.stringify(messages).length;
}
