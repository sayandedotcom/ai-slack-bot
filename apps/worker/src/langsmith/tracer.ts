/**
 * The LangSmith trace EMITTER. The sibling of `client.ts`, pointing the other
 * way.
 *
 * `client.ts` reads a CUSTOMER's traces so the agent can investigate their AI.
 * This writes OUR OWN: one trace per agent continuation — a root `chain` span,
 * one `llm` span per model step, one `tool` span per `run_code` call — so that
 * a run can be watched as a tree instead of reconstructed from D1 rows.
 *
 * Two projects, one workspace, one key. Reads are pinned to `LANGSMITH_PROJECT_ID`;
 * writes go to `LANGSMITH_TRACE_PROJECT` by NAME, because ingest addresses a
 * project by `session_name` and will create it on first write. Neither is ever
 * a caller argument, for the reason stated in `client.ts`: the credential is
 * workspace-wide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE IS NOT A CAPABILITY. It is not in `CapabilityDependencies`, not
 * in `PHASE_09_NAMESPACES`, and nothing the model authors can reach it. A sink
 * the model could write to is a sink the model could use to exfiltrate.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three properties the rest of the loop depends on, in order of how much
 * damage breaking one would do:
 *
 *  1. **Total.** Every `start*`/`end*` is synchronous and CANNOT throw. They are
 *     called from `onStepEnd` and from inside the `run_code` execute wrapper —
 *     a throw there would fail a run over telemetry. Internal failures bump a
 *     dropped-span counter that rides out in the root's `extra`.
 *  2. **One POST, no retries.** `flush()` sends everything once and gives up.
 *     Invariant 27 says there is one retry owner; a telemetry sink that retried
 *     would be a second one. A lost trace costs a trace.
 *  3. **Never on the critical path.** `flush()` is called through
 *     `ctx.waitUntil`, never awaited by the continuation. See the comment at
 *     its call site in `agent/loop.ts` — an awaited POST there can push a
 *     successful attempt past its deadline and cause a retry of committed work.
 */
import { boundedText, EVENT_CODE_PREVIEW_CHARS } from "../agent/audit";
import { NANO_USD_PER_USD } from "../agent/limits";
import { redact } from "../redact";

/**
 * Whether spans carry the prose, or only the numbers.
 *
 * `"none"` is the posture this repo held for AI Gateway from the start
 * (`cf-aig-collect-log-payload: false`, invariant 26): metadata telemetry, not
 * customer bodies. `"redacted"` sends bounded, scrubbed prompt/completion text
 * as well, which is what makes a trace legible to a human — and is a genuine
 * widening of what leaves the Worker, recorded in the README security model
 * rather than made quietly.
 *
 * Neither mode ever carries reasoning. See `SPAN_TEXT_DENY`.
 */
export type TracePayloadMode = "none" | "redacted";

export type LangSmithTracerConfig = {
  /** Fixed origin, fixed project. Neither is ever a caller argument. */
  endpoint: string;
  apiKey: string;
  /** `session_name` on ingest. The project traces land in. */
  project: string;
  /**
   * EXPLICIT. Absence is not a mode.
   *
   * `dependencies.ts` decides this from `LANGSMITH_TRACING` plus the presence
   * of a key, and a disabled tracer buffers nothing and fetches nothing. The
   * field is required so that "off" is a value someone typed rather than a
   * property of an object nobody finished building.
   */
  enabled: boolean;
  payloads: TracePayloadMode;
  /** Wall-clock budget for the one flush. */
  flushTimeoutMs?: number;
  /** Hard caps, so one pathological run cannot post megabytes. */
  maxSpans?: number;
  maxBodyBytes?: number;
};

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_SPANS = 128;
const DEFAULT_MAX_BODY_BYTES = 512_000;

/** Prompt/completion previews. Shorter than the event previews: nobody reads a trace for the full text. */
const SPAN_TEXT_CHARS = 2_000;

/**
 * Keys stripped from any extras object before it is serialized.
 *
 * Invariant 18 — no reasoning in RunEvents, D1 telemetry, logs, or Zep — and a
 * third-party trace store is squarely the same class of sink. The loop already
 * drops reasoning stream parts before they reach anything (`loop.ts`, the
 * `reasoning-*` cases in `consumeStream`), so this is the second of two
 * independent guards rather than the only one.
 *
 * `reasoning`, NOT `reason`. The looser pattern also swallowed `finish_reason`
 * and `raw_finish_reason` — two of the fields an operator actually opens a
 * trace to read — and did it silently, because a dropped key looks exactly like
 * a key nobody set. Caught by the "carries the scalars an operator reads" case.
 */
const SPAN_TEXT_DENY = /reasoning|thinking|thought/i;

/** Opaque handle. A caller cannot read or mutate a buffered span through it. */
export interface TraceSpan {
  readonly id: string;
}

export type RootSpanInput = {
  runId: string;
  generationId: string;
  agentTurnId: string;
  attempt: number;
  surface: string;
  startedAtMs: number;
};

export type RootSpanEnd = {
  endedAtMs: number;
  /** `ContinuationPath`, as a plain string — the tracer does not import the union. */
  path: string;
  errorCode: string | null;
  detail?: string;
  finalTurnId?: string;
  pausedApprovalId?: string;
};

/**
 * Token counts, in the loop's own vocabulary.
 *
 * Field names deliberately match `NormalizedUsage` (`agent/contracts.ts`)
 * EXACTLY, and all of them are required. They were optional and differently
 * named once — `cachedInputTokens`, `cacheCreationInputTokens` — which meant
 * the loop's `NormalizedUsage` satisfied the type while populating neither, and
 * every real trace shipped without cache figures. The unit test hand-built the
 * object and so agreed with itself. Optional fields on a mapping type are how
 * that happens; required ones make the mismatch a compile error.
 *
 * `reasoningTokens` is NOT carried. It is only a count, but invariant 18 is
 * cleaner to hold as "no reasoning field exists here" than as a judgement about
 * which reasoning-derived numbers are safe.
 */
export type SpanUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LlmSpanInput = {
  stepNumber: number;
  globalStep: number;
  modelId: string;
  provider: string;
  startedAtMs: number;
  /** `"redacted"` mode only. Ignored when `payloads === "none"`. */
  promptText?: string;
};

export type LlmSpanEnd = {
  endedAtMs: number;
  usage: SpanUsage;
  /** Total, integer nano-USD (invariant 29). Converted to float USD only on the wire. */
  costNanoUsd: number;
  /** The output half of the same figure, so the wire can carry a split. */
  outputCostNanoUsd: number;
  latencyMs: number;
  finishReason: string;
  rawFinishReason: string | null;
  providerRequestId: string | null;
  gatewayLogId: string | null;
  errorCode: string | null;
  /** `"redacted"` mode only. The assistant's TEXT parts. NEVER reasoning. */
  outputText?: string;
};

export type ToolSpanInput = {
  toolName: string;
  toolCallId: string;
  startedAtMs: number;
  /** `"redacted"` mode only: the program the model authored. */
  code?: string;
};

export type ToolSpanEnd = {
  endedAtMs: number;
  ok: boolean;
  durationMs: number;
  capabilityCalls: number;
  errorCode: string | null;
  /** `"redacted"` mode only. */
  resultPreview?: string;
};

export type TraceFlushOutcome =
  | "disabled"
  | "empty"
  | "sent"
  | "rejected"
  | "timeout"
  | "network_error";

export type TraceFlushReport = {
  outcome: TraceFlushOutcome;
  posted: number;
  status?: number;
  /** Spans the caller opened that this tracer refused to buffer (over `maxSpans`, or a serialization failure). */
  dropped: number;
};

export interface LangSmithTracer {
  readonly traceId: string;
  /** Buffered spans. For tests and for the dropped-span accounting; not a wire field. */
  readonly size: number;
  startRoot(input: RootSpanInput): TraceSpan;
  endRoot(span: TraceSpan, end: RootSpanEnd): void;
  startLlm(parent: TraceSpan, input: LlmSpanInput): TraceSpan;
  endLlm(span: TraceSpan, end: LlmSpanEnd): void;
  startTool(parent: TraceSpan, input: ToolSpanInput): TraceSpan;
  endTool(span: TraceSpan, end: ToolSpanEnd): void;
  /** ONE POST to `/runs/batch`. Memoised, never throws, never retries. */
  flush(): Promise<TraceFlushReport>;
}

/* --------------------------------------------------------------- wire shape -- */

/**
 * One LangSmith run object.
 *
 * Field names and the `dotted_order` construction are taken verbatim from
 * `scripts/langsmith-seed.mjs`, which is the only shape in this repo proven to
 * post successfully against this workspace. Do not "tidy" them against the
 * published docs without re-seeding — see the open questions in that script.
 */
type WireRun = {
  id: string;
  trace_id: string;
  parent_run_id?: string;
  dotted_order: string;
  name: string;
  run_type: "chain" | "llm" | "tool";
  start_time: string;
  end_time?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  session_name: string;
  extra: { metadata: Record<string, unknown> };
};

/**
 * LangSmith's `dotted_order` timestamp: compact ISO, no separators, and
 * MICROSECONDS — exactly six fractional digits.
 *
 * `2026-08-17T12:00:00.000Z` → `20260817T120000000000Z`.
 *
 * MEASURED 2026-08-17, and it is a hard requirement, not a preference. Ingest
 * parses this with the Go layout `20060102T150405.000000` and rejects anything
 * else with HTTP 400:
 *
 *   invalid 'dotted_order': ... parsing time "20260817T083114.022" as
 *   "20060102T150405.000000": cannot parse ".022" as ".000000"
 *
 * `toISOString()` yields three fractional digits, so they are padded to six.
 * `scripts/langsmith-seed.mjs` does NOT pad — its ingest has therefore never
 * succeeded, which is consistent with `phase-09-notes.md` recording that the
 * seeded project has zero runs. Do not "align" this back to that script.
 */
function compact(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "")
    .replace("Z", "000Z");
}

/**
 * Serialize defensively.
 *
 * A span body is built from values the model influenced, so it can be circular,
 * enormous, or carry a key we do not want. Anything that fails to serialize
 * becomes a marker string rather than an exception — see property 1.
 */
function safeExtras(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SPAN_TEXT_DENY.test(key)) continue;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(raw)) as unknown;
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}

/** Scrub, THEN bound. Bounding first can leave a prefix the pattern no longer matches. */
function prose(text: string, limit = SPAN_TEXT_CHARS): string {
  return boundedText(redact(text), limit);
}

/* ------------------------------------------------------------- the tracer -- */

export function makeLangSmithTracer(
  config: LangSmithTracerConfig,
  clock: () => number,
): LangSmithTracer {
  if (!config.enabled || config.apiKey === "" || config.project === "") {
    return makeNoopTracer();
  }

  const endpoint = config.endpoint.replace(/\/$/, "");
  const maxSpans = config.maxSpans ?? DEFAULT_MAX_SPANS;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const flushTimeoutMs = config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const withText = config.payloads === "redacted";

  const traceId = crypto.randomUUID();
  const runs = new Map<string, WireRun>();
  /** Insertion order, so the batch posts parents before children. */
  const order: string[] = [];
  let dropped = 0;
  let rootOrder: string | null = null;
  let memoised: Promise<TraceFlushReport> | null = null;

  /**
   * Ordering guard.
   *
   * Two spans that start in the same millisecond produce identical timestamp
   * segments, and their relative order in the trace becomes whatever LangSmith's
   * tiebreak happens to be. Under a fixed test clock that is EVERY span. Nudging
   * each start to at least one past the previous keeps the tree deterministic
   * without misreporting `start_time`, which is written from the real value.
   */
  let lastOrderMs = 0;
  function orderStamp(startedAtMs: number): string {
    const at = startedAtMs > lastOrderMs ? startedAtMs : lastOrderMs + 1;
    lastOrderMs = at;
    return compact(at);
  }

  function add(run: WireRun): TraceSpan {
    if (runs.size >= maxSpans) {
      dropped += 1;
      return { id: run.id };
    }
    runs.set(run.id, run);
    order.push(run.id);
    return { id: run.id };
  }

  function close(
    span: TraceSpan,
    endedAtMs: number,
    outputs: Record<string, unknown>,
    error?: string,
  ): void {
    const run = runs.get(span.id);
    if (!run) return;
    run.end_time = new Date(endedAtMs).toISOString();
    run.outputs = safeExtras(outputs);
    if (error !== undefined && error !== "") run.error = error;
  }

  return {
    traceId,
    get size() {
      return runs.size;
    },

    startRoot(input) {
      const id = traceId;
      rootOrder = `${orderStamp(input.startedAtMs)}${id}`;
      return add({
        id,
        trace_id: traceId,
        dotted_order: rootOrder,
        name: `run ${input.surface}`,
        run_type: "chain",
        start_time: new Date(input.startedAtMs).toISOString(),
        inputs: safeExtras({
          run_id: input.runId,
          generation_id: input.generationId,
          agent_turn_id: input.agentTurnId,
          attempt: input.attempt,
          surface: input.surface,
        }),
        session_name: config.project,
        extra: {
          metadata: safeExtras({
            run_id: input.runId,
            generation_id: input.generationId,
            attempt: input.attempt,
            surface: input.surface,
          }),
        },
      });
    },

    endRoot(span, end) {
      close(
        span,
        end.endedAtMs,
        {
          outcome_path: end.path,
          error_code: end.errorCode,
          final_turn_id: end.finalTurnId,
          paused_approval_id: end.pausedApprovalId,
          dropped_spans: dropped,
        },
        end.errorCode === null ? undefined : `${end.errorCode}${end.detail === undefined ? "" : `: ${prose(end.detail, 400)}`}`,
      );
    },

    startLlm(parent, input) {
      const id = crypto.randomUUID();
      const stamp = orderStamp(input.startedAtMs);
      return add({
        id,
        trace_id: traceId,
        parent_run_id: parent.id,
        dotted_order: rootOrder === null ? stamp + id : `${rootOrder}.${stamp}${id}`,
        name: `step ${input.globalStep}`,
        run_type: "llm",
        start_time: new Date(input.startedAtMs).toISOString(),
        inputs: safeExtras({
          step_number: input.stepNumber,
          global_step: input.globalStep,
          model_id: input.modelId,
          provider: input.provider,
          ...(withText && input.promptText !== undefined
            ? { prompt: prose(input.promptText) }
            : {}),
        }),
        session_name: config.project,
        extra: {
          metadata: safeExtras({
            // `ls_model_name` and `ls_provider` are the keys LangSmith looks for
            // to identify the model. Without `ls_model_name` it records tokens
            // but computes no cost at all. We send our own cost regardless, so
            // these are for grouping and filtering in the UI rather than for
            // pricing — but a trace that cannot say which model ran is not worth
            // much either.
            ls_model_name: input.modelId,
            ls_provider: input.provider,
            model_id: input.modelId,
            provider: input.provider,
            global_step: input.globalStep,
          }),
        },
      });
    },

    endLlm(span, end) {
      close(
        span,
        end.endedAtMs,
        {
          // THE SHAPE LANGSMITH ACTUALLY READS, and it is not obvious.
          //
          // MEASURED 2026-08-17 against live ingest. Token counts are picked up
          // from exactly two places — `outputs.usage_metadata` (this one) and
          // `outputs.llm_output.token_usage`. A top-level `usage_metadata` on
          // the run, `extra.usage_metadata`, top-level `prompt_tokens`, and the
          // provider-native `outputs.usage` are ALL accepted with HTTP 202 and
          // silently discarded: the run comes back with 0 tokens, $0.00, and
          // `usage_metadata: null`. The published docs describe the SDK's
          // run-tree object, which is not this.
          //
          // Cost is OURS, not LangSmith's. Given tokens and an `ls_model_name`
          // it recognises, LangSmith will happily invent a figure — it produced
          // $0.02 for a model it cannot know. Sending explicit costs overrides
          // that exactly (verified: 0.123456 round-tripped), which is what keeps
          // this column equal to `agent_model_calls` in D1 and to the number the
          // spend guard enforces against the run ceiling. Two systems disagreeing
          // about spend is worse than one system not showing it.
          usage_metadata: {
            input_tokens: end.usage.inputTokens,
            output_tokens: end.usage.outputTokens,
            total_tokens: end.usage.totalTokens,
            input_token_details: {
              cache_read: end.usage.cacheReadTokens,
              cache_creation: end.usage.cacheWriteTokens,
            },
            // Integer nano-USD is the internal unit (invariant 29); USD floats
            // exist only here, on the wire, because that is what LangSmith takes.
            input_cost: (end.costNanoUsd - end.outputCostNanoUsd) / NANO_USD_PER_USD,
            output_cost: end.outputCostNanoUsd / NANO_USD_PER_USD,
            total_cost: end.costNanoUsd / NANO_USD_PER_USD,
          },
          cost_nano_usd: end.costNanoUsd,
          latency_ms: end.latencyMs,
          finish_reason: end.finishReason,
          raw_finish_reason: end.rawFinishReason,
          provider_request_id: end.providerRequestId,
          gateway_log_id: end.gatewayLogId,
          error_code: end.errorCode,
          ...(withText && end.outputText !== undefined
            ? { completion: prose(end.outputText) }
            : {}),
        },
        end.errorCode ?? undefined,
      );
    },

    startTool(parent, input) {
      const id = crypto.randomUUID();
      const stamp = orderStamp(input.startedAtMs);
      return add({
        id,
        trace_id: traceId,
        parent_run_id: parent.id,
        dotted_order: rootOrder === null ? stamp + id : `${rootOrder}.${stamp}${id}`,
        name: input.toolName,
        run_type: "tool",
        start_time: new Date(input.startedAtMs).toISOString(),
        inputs: safeExtras({
          tool_name: input.toolName,
          tool_call_id: input.toolCallId,
          ...(withText && input.code !== undefined
            ? { code: prose(input.code, EVENT_CODE_PREVIEW_CHARS) }
            : {}),
        }),
        session_name: config.project,
        extra: { metadata: safeExtras({ tool_call_id: input.toolCallId }) },
      });
    },

    endTool(span, end) {
      close(
        span,
        end.endedAtMs,
        {
          ok: end.ok,
          duration_ms: end.durationMs,
          capability_calls: end.capabilityCalls,
          error_code: end.errorCode,
          ...(withText && end.resultPreview !== undefined
            ? { result: prose(end.resultPreview) }
            : {}),
        },
        end.errorCode ?? undefined,
      );
    },

    flush() {
      if (memoised) return memoised;
      memoised = (async (): Promise<TraceFlushReport> => {
        if (order.length === 0) return { outcome: "empty", posted: 0, dropped };

        // A span the caller opened and never closed — a `halt()`, a throw, an
        // abort. Closing it here is what keeps a partial run a WELL-FORMED
        // trace instead of one LangSmith renders as still running forever.
        const flushedAt = clock();
        const post: WireRun[] = [];
        // Seeded with the envelope — `{"post":[]}` — and each run costs its own
        // length plus the joining comma. Counting only the runs would let the
        // finished body exceed the cap by the wrapper, which is small but makes
        // `maxBodyBytes` a rough guide rather than a bound.
        let bytes = '{"post":[]}'.length;
        let truncated = 0;
        for (const id of order) {
          const run = runs.get(id);
          if (!run) continue;
          if (run.end_time === undefined) {
            run.end_time = new Date(flushedAt).toISOString();
            run.error = run.error ?? "span_not_closed";
          }
          const size = JSON.stringify(run).length + (post.length === 0 ? 0 : 1);
          if (bytes + size > maxBodyBytes) {
            truncated += 1;
            continue;
          }
          bytes += size;
          post.push(run);
        }
        if (post.length === 0) return { outcome: "empty", posted: 0, dropped: dropped + truncated };

        try {
          const response = await fetch(`${endpoint}/runs/batch`, {
            method: "POST",
            // Same header policy as the reader: `x-api-key`, never
            // `Authorization`. LangSmith ignores a bearer token and the request
            // fails as unauthenticated (verified live 2026-08-12).
            headers: { "x-api-key": config.apiKey, "content-type": "application/json" },
            body: JSON.stringify({ post }),
            signal: AbortSignal.timeout(flushTimeoutMs),
          });
          return {
            outcome: response.ok ? "sent" : "rejected",
            posted: response.ok ? post.length : 0,
            status: response.status,
            dropped: dropped + truncated,
          };
        } catch (error) {
          // `AbortSignal.timeout` surfaces as a `TimeoutError` DOMException; a
          // dead host surfaces as a TypeError. Both are the same decision here
          // — give up — but an operator reading the warn wants to know which.
          const timedOut = error instanceof Error && error.name === "TimeoutError";
          return {
            outcome: timedOut ? "timeout" : "network_error",
            posted: 0,
            dropped: dropped + truncated,
          };
        }
      })();
      return memoised;
    },
  };
}

/**
 * The default everywhere the feature is off.
 *
 * Buffers nothing and fetches nothing, so every existing construction of
 * `ContinuationDeps` and every test that does not ask for tracing is unchanged
 * — and a misconfigured deploy degrades to silence rather than to an outbound
 * call with an empty key.
 */
export function makeNoopTracer(): LangSmithTracer {
  const span: TraceSpan = { id: "noop" };
  return {
    traceId: "noop",
    size: 0,
    startRoot: () => span,
    endRoot: () => {},
    startLlm: () => span,
    endLlm: () => {},
    startTool: () => span,
    endTool: () => {},
    flush: async () => ({ outcome: "disabled", posted: 0, dropped: 0 }),
  };
}
