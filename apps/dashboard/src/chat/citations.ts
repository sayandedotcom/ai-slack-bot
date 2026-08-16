/**
 * Pure citation extraction for the chat page. Every capability call the agent
 * makes arrives as a `tool_call` item named `namespace.method`; completed
 * `memory.cite` calls carry `{factId, fact, permalink, ts}[]` outputs (the
 * worker strips `channel_id` before the model ever sees it — see
 * `apps/worker/src/codemode/bindings/memory.ts`). The chip's channel caption is
 * therefore *parsed out of* the stored permalink; nothing here ever assembles a
 * Slack URL from parts.
 */

import type { SessionItem } from "../runs/session-reducer";

export type SourceChip = {
  factId: string;
  fact: string;
  permalink: string;
  /** The `/archives/<CHANNEL>/` segment of the permalink; null when absent. */
  channelId: string | null;
  ts: string;
};

/** Mirrors the worker's generated `CiteOutput` element — keep in step. */
type CiteEntry = { factId: string; fact: string; permalink: string; ts: string };

function isCiteEntry(value: unknown): value is CiteEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.factId === "string" &&
    typeof record.fact === "string" &&
    typeof record.permalink === "string" &&
    typeof record.ts === "string"
  );
}

export function channelFromPermalink(permalink: string): string | null {
  const match = /^https:\/\/[^/\s]*slack\.com\/archives\/([A-Za-z0-9]+)\//.exec(permalink);
  return match === null ? null : (match[1] as string);
}

/** Turn one entry into a chip, dropping anything already collected. */
function pushChip(raw: CiteEntry, seen: Set<string>, chips: SourceChip[]): void {
  if (seen.has(raw.permalink)) return;
  seen.add(raw.permalink);
  chips.push({
    factId: raw.factId,
    fact: raw.fact,
    permalink: raw.permalink,
    channelId: channelFromPermalink(raw.permalink),
    ts: raw.ts,
  });
}

/** Completed `memory.cite` outputs across the session, deduped by permalink, in call order. */
export function extractSources(items: SessionItem[]): SourceChip[] {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    if (item.call.name !== "memory.cite" || item.call.state !== "completed") continue;
    if (!Array.isArray(item.call.output)) continue;
    for (const raw of item.call.output) {
      // Malformed entries contribute nothing and throw nothing: a foreign or
      // truncated payload must never take the page down.
      if (!isCiteEntry(raw)) continue;
      pushChip(raw, seen, chips);
    }
  }
  return chips;
}

/** Bounded so a self-referential or pathological payload cannot spin the tab. */
const SCAN_DEPTH = 6;
const SCAN_NODES = 5_000;

/**
 * The same chips, found the way the Think chassis leaves them.
 *
 * On this chassis the model has exactly ONE tool, `run_code`, and every
 * capability call — `memory.cite` included — happens inside the isolate. So
 * there is no `memory.cite` tool part to read: the cited facts come back nested
 * somewhere inside whatever the model's own code chose to return. This walks
 * that value looking for the `CiteEntry` shape rather than a fixed path,
 * because the shape is the contract (`apps/worker/src/codemode/bindings/memory.ts`)
 * and the path is the model's whim.
 *
 * Structural matching is safe here for one reason worth stating: the four
 * required fields include a `permalink` this file already refuses to render
 * unless it parses as a Slack archive URL, and the chip links to that stored
 * permalink verbatim — nothing is ever assembled from parts.
 */
export function sourcesFromToolOutput(output: unknown): SourceChip[] {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];
  let budget = SCAN_NODES;

  const walk = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > SCAN_DEPTH || value === null || typeof value !== "object") return;
    if (isCiteEntry(value)) {
      pushChip(value, seen, chips);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(value as Record<string, unknown>)) walk(entry, depth + 1);
  };

  walk(output, 0);
  return chips;
}

export type ContentSegment = { kind: "text"; text: string } | { kind: "link"; url: string };

/**
 * Conservative on purpose: only `https://…slack.com/archives/…` URLs already
 * present verbatim become links; anything else — including scheme-less
 * URL-shaped strings — stays text.
 */
const SLACK_PERMALINK = /https:\/\/[^\s<>"]*slack\.com\/archives\/[^\s<>"]+/g;

export function linkifySlackUrls(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(SLACK_PERMALINK)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: content.slice(last, index) });
    segments.push({ kind: "link", url: match[0] });
    last = index + match[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}
