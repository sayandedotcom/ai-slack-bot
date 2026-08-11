import { CapabilityError } from "../codemode/errors";
import type {
  BetterStackReader,
  LogLine,
  Monitor,
} from "../codemode/gateways";

const MAX_LINES = 200;
/** Retention on the configured source is 3 days; asking wider just costs time. */
const MAX_WINDOW_MS = 7 * 86_400_000;

export type BetterStackConfig = {
  /** ClickHouse-compatible endpoint. Region-scoped and fixed in configuration. */
  sqlEndpoint: string;
  sqlUsername: string;
  sqlPassword: string;
  /** Allowlisted log collections. The model never names one. */
  logCollections: readonly string[];
  uptimeToken: string;
  uptimeEndpoint: string;
};

/**
 * Fields the agent may see about a monitor. An ALLOWLIST, never a denylist.
 *
 * Verified against the live API 2026-08-12: a monitor record also carries
 * `auth_password`, `auth_username`, `request_headers`, `request_body`,
 * `environment_variables` and `playwright_script` — the credentials each
 * monitor uses to authenticate against whatever it watches. Passing the record
 * through, or removing the fields known to be sensitive today, hands those to
 * model code the first time upstream adds a field nobody thought to denylist.
 */
const MONITOR_FIELDS = ["id", "name", "status", "lastCheckedAt"] as const;

/**
 * Patterns redacted from returned log lines.
 *
 * Defense in depth only. Logs are written by another system and we do not
 * control what goes into them, so this reduces the blast radius of somebody
 * else's mistake — it is not a guarantee.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(authorization|cookie|set-cookie)\s*[:=]\s*\S+/gi, "$1: [redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]"],
  [/\b(sk|lin_api|lsv2_pt|sb_secret)[-_][A-Za-z0-9-]{8,}/g, "[redacted-key]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[redacted-email]"],
];

function redact(message: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), message);
}

function invalid(reason: string): CapabilityError {
  return new CapabilityError("invalid_input", reason);
}

function parseInstant(label: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw invalid(`'${label}' must be an ISO-8601 instant, for example 2026-08-11T00:00:00Z.`);
  }
  return parsed;
}

/** ClickHouse DateTime64 literal, always UTC. */
function toClickHouse(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function upstreamError(status: number, what: string): CapabilityError {
  if (status === 401 || status === 403) {
    return new CapabilityError("capability_unavailable", `${what} is not authorised right now.`);
  }
  if (status === 429) {
    return new CapabilityError("upstream_unavailable", `${what} is rate limited. Wait before trying again.`);
  }
  return new CapabilityError("upstream_unavailable", `${what} is unavailable.`);
}

type ClickHouseRow = { dt?: string; raw?: string; level?: string };

/** Pull a level out of a structured line, or fall back to a plain scan. */
function levelOf(raw: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const found = parsed.level ?? parsed.severity ?? parsed.levelname;
    if (typeof found === "string") return found.toLowerCase();
  } catch {
    // Not JSON; fall through.
  }
  const match = /\b(trace|debug|info|warn|warning|error|fatal|critical)\b/i.exec(raw);
  return match ? match[1].toLowerCase() : "unknown";
}

export function makeBetterStackReader(
  config: BetterStackConfig,
  now: () => number,
): BetterStackReader {
  return {
    async logs(input): Promise<LogLine[]> {
      const collection = config.logCollections[0];
      if (collection === undefined) {
        throw new CapabilityError(
          "capability_unavailable",
          "no log source is configured, so there are no logs to search.",
        );
      }
      if (input.query.replace(/[%_*\s]/g, "").length === 0) {
        throw invalid("the search needs actual terms; a wildcard-only query would return everything.");
      }

      const since = parseInstant("since", input.since);
      const until = input.until === null ? now() : parseInstant("until", input.until);
      if (until <= since) throw invalid("'until' must be after 'since'.");
      if (since > now()) throw invalid("'since' cannot be in the future.");
      if (until - since > MAX_WINDOW_MS) {
        throw invalid(`the window is too wide; ask for at most ${MAX_WINDOW_MS / 86_400_000} days at a time.`);
      }

      const limit = Math.min(Math.max(input.limit, 1), MAX_LINES);

      // The collection name is an allowlisted literal; everything the model
      // supplied is a BOUND PARAMETER. ClickHouse's {name:Type} placeholders
      // are what keep a query string from becoming a query.
      const sql =
        `SELECT dt, raw FROM remote(${collection}) ` +
        `WHERE dt >= {since:DateTime64(3)} AND dt <= {until:DateTime64(3)} ` +
        `AND positionCaseInsensitive(toString(raw), {q:String}) > 0 ` +
        `ORDER BY dt DESC LIMIT ${limit} FORMAT JSON`;

      const body = new URLSearchParams({
        query: sql,
        param_since: toClickHouse(since),
        param_until: toClickHouse(until),
        param_q: input.query,
      });

      let response: Response;
      try {
        response = await fetch(config.sqlEndpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${config.sqlUsername}:${config.sqlPassword}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
        });
      } catch {
        throw upstreamError(0, "log search");
      }
      if (!response.ok) throw upstreamError(response.status, "log search");

      let payload: { data?: ClickHouseRow[]; exception?: string };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new CapabilityError("upstream_unavailable", "log search returned something unreadable.");
      }
      if (payload.exception) {
        // The exception text names internal collections and the connection
        // user, so it is logged here and never handed to the model.
        throw new CapabilityError(
          "upstream_unavailable",
          "log search could not read the configured source.",
        );
      }

      return (payload.data ?? []).map((row) => {
        const raw = String(row.raw ?? "");
        return {
          at: new Date(`${String(row.dt ?? "").replace(" ", "T")}Z`).toISOString(),
          level: levelOf(raw, row.level),
          message: redact(raw),
        };
      });
    },

    async monitors(): Promise<Monitor[]> {
      let response: Response;
      try {
        response = await fetch(`${config.uptimeEndpoint}/monitors`, {
          headers: { authorization: `Bearer ${config.uptimeToken}` },
        });
      } catch {
        throw upstreamError(0, "uptime state");
      }
      if (!response.ok) throw upstreamError(response.status, "uptime state");

      let payload: { data?: Array<{ id?: string; attributes?: Record<string, unknown> }> };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new CapabilityError("upstream_unavailable", "uptime state returned something unreadable.");
      }

      return (payload.data ?? []).map((entry) => {
        const attributes = entry.attributes ?? {};
        // Built field by field from MONITOR_FIELDS. Nothing is spread.
        const monitor: Monitor = {
          id: String(entry.id ?? ""),
          name: String(attributes.pronounceable_name ?? attributes.url ?? "unnamed"),
          status: String(attributes.status ?? "unknown"),
          lastCheckedAt:
            typeof attributes.last_checked_at === "string" ? attributes.last_checked_at : null,
        };
        return monitor;
      });
    },
  };
}

export { MONITOR_FIELDS };
