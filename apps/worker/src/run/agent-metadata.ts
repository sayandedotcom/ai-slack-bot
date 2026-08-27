/**
 * Reading values that have crossed a durable boundary.
 *
 * Four of the run agent's inputs are not arguments: they are JSON that was
 * written by some earlier build of this Worker and read back by this one — a
 * scheduled callback's payload out of DO SQLite, and the turn metadata the SDK
 * persists on a user message so a RECOVERED turn can re-resolve what it was
 * started for. A schedule row or a stored turn can outlive a deploy, so a shape
 * that no longer matches is a thing to DROP rather than to crash on: throwing
 * would take out an approval nudge or a whole recovered turn over a field that
 * has been renamed.
 *
 * Every function here is total — it answers null or an empty list for anything
 * it does not recognise — and none of them reads the agent. That is what makes
 * this the only module in the run layer with no `this` in it.
 */
import type { RecalledFact, ThreadMessage } from "./agent-prompt";

/**
 * The approval id off a scheduled payload, or null.
 *
 * Validated rather than trusted: a schedule row round-trips through JSON in DO
 * SQLite and can outlive a deploy, so one written by an older build is a thing
 * to drop rather than to crash on.
 */
export function readApprovalId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { approvalId?: unknown }).approvalId;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** The turn id stamped on this turn's user message, if it carries one. */
export function readTurnId(
  metadata: Record<string, unknown> | undefined
): string | null {
  const raw = metadata?.turnId;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** The revision stamped on this turn's user message, if it carries one. */
export function readTurnRevision(
  metadata: Record<string, unknown> | undefined
): number | null {
  const raw = metadata?.inputRevision;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0
    ? raw
    : null;
}

/**
 * The thread this turn was woken on, from the turn's own metadata.
 *
 * Turn metadata is the SDK's recovery-safe, server-only carrier: reserved keys
 * on client-supplied messages are stripped at intake, and the value is
 * persisted on the user message so a recovered turn re-resolves it. Read
 * defensively anyway — it crosses a durable boundary, so a row written by an
 * older build is a thing to ignore rather than to crash on.
 */
export function readTurnThread(
  metadata: Record<string, unknown> | undefined
): ThreadMessage[] {
  const raw = metadata?.thread;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string" || typeof record.ts !== "string")
      return [];
    return [
      {
        ts: record.ts,
        userId: typeof record.userId === "string" ? record.userId : null,
        text: record.text,
        permalink:
          typeof record.permalink === "string" ? record.permalink : null,
      },
    ];
  });
}

/** The facts recalled for this turn, from the turn's own metadata. */
export function readTurnRecall(
  metadata: Record<string, unknown> | undefined
): RecalledFact[] {
  const raw = metadata?.recall;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.fact !== "string") return [];
    return [
      {
        fact: record.fact,
        citation: typeof record.citation === "string" ? record.citation : null,
      },
    ];
  });
}
