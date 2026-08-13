import { CapabilityError } from "../codemode/errors";
import type {
  LangSmithReader,
  Trace,
  TraceNode,
  TraceRef,
} from "../codemode/gateways";

/**
 * Caps that are independent of each other on purpose: a trace can be wide
 * (many nodes), deep (long chains), or heavy (huge prompts), and any one of
 * those alone can blow the model's context.
 */
const MAX_NODES = 80;
const MAX_PREVIEW_CHARS = 400;
const MAX_LOOKBACK_DAYS = 30;
const MAX_SEARCH_LIMIT = 100;

export type LangSmithConfig = {
  /** Fixed origin, fixed project. Neither is ever a model argument. */
  endpoint: string;
  apiKey: string;
  projectId: string;
  projectName: string;
};

/**
 * `x-api-key`, NOT `Authorization`. Verified live 2026-08-12 — LangSmith
 * ignores a bearer token and the request fails as unauthenticated.
 */
function headers(apiKey: string): HeadersInit {
  return { "x-api-key": apiKey, "content-type": "application/json" };
}

/** The subset of LangSmith's run shape this reader consumes. */
type RawRun = {
  id?: string;
  trace_id?: string;
  parent_run_id?: string | null;
  name?: string;
  run_type?: string;
  status?: string;
  start_time?: string;
  end_time?: string | null;
  error?: string | null;
  inputs?: unknown;
  outputs?: unknown;
};

function preview(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (text === undefined) return "";
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}… [TRUNCATED]`
    : text;
}

function durationMs(run: RawRun): number {
  if (!run.start_time || !run.end_time) return 0;
  const started = Date.parse(run.start_time);
  const ended = Date.parse(run.end_time);
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

function toNode(run: RawRun): TraceNode {
  return {
    id: String(run.id ?? ""),
    parentId: run.parent_run_id ?? null,
    name: String(run.name ?? "unnamed"),
    runType: String(run.run_type ?? "unknown"),
    status: String(run.status ?? "unknown"),
    startedAt: String(run.start_time ?? ""),
    durationMs: durationMs(run),
    inputPreview: preview(run.inputs),
    outputPreview: preview(run.outputs),
    error: run.error ?? null,
  };
}

/** ISO-8601 only, and only inside the reviewed lookback. */
function parseSince(since: string | null, now: number): string | null {
  if (since === null) return null;
  const parsed = Date.parse(since);
  if (!Number.isFinite(parsed)) {
    throw new CapabilityError(
      "invalid_input",
      "'since' must be an ISO-8601 instant, for example 2026-08-11T00:00:00Z.",
    );
  }
  if (parsed > now) {
    throw new CapabilityError("invalid_input", "'since' cannot be in the future.");
  }
  const earliest = now - MAX_LOOKBACK_DAYS * 86_400_000;
  return new Date(Math.max(parsed, earliest)).toISOString();
}

function upstreamError(status: number): CapabilityError {
  if (status === 401 || status === 403) {
    return new CapabilityError(
      "capability_unavailable",
      "trace history is not authorised right now.",
    );
  }
  if (status === 429) {
    return new CapabilityError(
      "upstream_unavailable",
      "trace history is rate limited. Wait before trying again.",
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    "trace history is unavailable.",
  );
}

export function makeLangSmithReader(
  config: LangSmithConfig,
  now: () => number,
): LangSmithReader {
  async function queryRuns(body: Record<string, unknown>): Promise<RawRun[]> {
    let response: Response;
    try {
      response = await fetch(`${config.endpoint}/runs/query`, {
        method: "POST",
        headers: headers(config.apiKey),
        // The project is injected here. A model query is a VALUE in this body,
        // never part of the URL and never a filter expression.
        body: JSON.stringify({ ...body, session: [config.projectId] }),
      });
    } catch {
      throw upstreamError(0);
    }
    if (!response.ok) throw upstreamError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CapabilityError(
        "upstream_unavailable",
        "trace history returned something unreadable.",
      );
    }
    const runs = (payload as { runs?: unknown })?.runs;
    return Array.isArray(runs) ? (runs as RawRun[]) : [];
  }

  return {
    async trace(traceId): Promise<Trace> {
      if (!/^[0-9a-fA-F-]{8,64}$/.test(traceId)) {
        throw new CapabilityError(
          "invalid_input",
          "that does not look like a trace identifier.",
        );
      }

      // One extra so we can tell "exactly full" from "there was more".
      const runs = await queryRuns({ trace: traceId, limit: MAX_NODES + 1 });
      if (runs.length === 0) {
        throw new CapabilityError(
          "invalid_input",
          "no trace with that identifier exists in the configured project.",
        );
      }

      const truncated = runs.length > MAX_NODES;
      const kept = runs.slice(0, MAX_NODES);
      const root = kept.find((r) => !r.parent_run_id) ?? kept[0];

      return {
        traceId: String(root.trace_id ?? traceId),
        name: String(root.name ?? "unnamed"),
        startedAt: String(root.start_time ?? ""),
        status: String(root.status ?? "unknown"),
        nodes: kept.map(toNode),
        truncated,
      };
    },

    async searchTraces(input): Promise<TraceRef[]> {
      const since = parseSince(input.since, now());
      const fetched = await queryRuns({
        limit: Math.min(Math.max(input.limit, 1), MAX_SEARCH_LIMIT),
        // Root runs only: a search should return traces, not every span inside
        // them, or one busy trace fills the whole result.
        is_root: true,
        ...(since !== null ? { start_time: since } : {}),
        // `query` is deliberately NOT forwarded. Upstream it is a freeform
        // natural-language filter GENERATOR, and it answers plain keywords
        // like "export" with 400 "Failed to generate filter from freeform
        // query" — which upstreamError() would then mislabel as the whole
        // trace service being down (observed live, 2026-08-13). The term is
        // applied here instead, against the run names of the bounded page the
        // filterless request returns.
      });

      const term = input.query?.trim().toLowerCase() ?? "";
      const runs =
        term === ""
          ? fetched
          : fetched.filter((run) =>
              String(run.name ?? "").toLowerCase().includes(term),
            );

      return runs.map((run) => ({
        traceId: String(run.trace_id ?? run.id ?? ""),
        name: String(run.name ?? "unnamed"),
        startedAt: String(run.start_time ?? ""),
        status: String(run.status ?? "unknown"),
      }));
    },
  };
}
