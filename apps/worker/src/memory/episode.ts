/**
 * What the agent's half of memory is made of.
 *
 * Zep already receives customer MESSAGES. This module builds the other half:
 * what the agent was ASKED, what it DID, what it DRAFTED, and how it ENDED —
 * one bounded, redacted episode per settled generation, plus the exact source
 * descriptors that let a later claim be traced back to a real Slack message.
 *
 * Pure on purpose. No storage, no D1, no Zep, no clock. Everything here is a
 * total function of values the caller already holds, which is what lets the
 * redaction rules be tested one at a time rather than through a Durable Object.
 *
 * THE EXCLUSION LIST IS THE POINT (invariants 18, 25, 33, 39). An episode is
 * durable semantic memory that later answers are built on, so the following
 * never enter one, and each has its own test:
 *
 *  - assistant delta text beyond the SELECTED final draft;
 *  - generated Code Mode source;
 *  - raw Slack / log / trace / database tool RESULTS;
 *  - Fable thinking blocks and their signatures;
 *  - secrets and credential-shaped strings;
 *  - token deltas and model reasoning of any kind.
 *
 * The structural half of that guarantee is that this module cannot see most of
 * them: it is handed an already-selected final draft, a list of capability
 * NAMES, and turn text — never a stream part, never a tool result body, never a
 * response message. `redactSecrets` is defence in depth on top, for the one
 * thing that can legitimately arrive inside customer text.
 */

/* --------------------------------------------------------------- limits -- */

/**
 * Bounds, in characters. Small on purpose: an episode is a semantic summary,
 * not an archive, and Zep's extraction quality falls off a cliff on a wall of
 * text. The transcript stays in RunDO, where it belongs.
 */
export const EPISODE_LIMITS = {
  asked: 1000,
  draft: 2000,
  action: 120,
  actions: 24,
  /** Zep's verified maximum number of metadata tags. */
  metadataTags: 10,
  /** Zep's verified maximum `sourceDescription` length. */
  sourceDescription: 500,
  /** Bounded so one generation cannot write an unbounded number of D1 rows. */
  sources: 32,
} as const;

export const EPISODE_OUTCOMES = [
  "completed",
  "failed",
  "refused",
  "budget_exhausted",
] as const;

export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];

/**
 * The episode body, exactly as the plan's memory contract specifies it. Snake
 * case is deliberate: this JSON is what Zep extracts over, and the field names
 * are part of the semantic surface, not an internal type.
 */
export type AgentEpisode = {
  asked: string;
  actions: string[];
  draft: string;
  outcome: EpisodeOutcome;
  /** The opaque public run id. Never a channel, a thread, or a customer name. */
  run_id: string;
  agent_turn_id: string;
};

/**
 * A pointer to evidence, NOT a resolved citation.
 *
 * Resolution to a permalink happens in D1 at projection time, against the
 * `messages` row that actually exists. Carrying a permalink through here would
 * be carrying a copy, and a copy is exactly what "never generate a Slack URL
 * from components" exists to prevent.
 *
 *  - `run_turn`   — an input turn of this generation. `ref` is the Slack event
 *    id its metadata carried; a Chat turn has none and produces no descriptor.
 *  - `zep_episode` — an episode UUID a memory read RETURNED. Resolved through
 *    `zep_episodes` to the message it was built from.
 *  - `slack_message` — a stored message event id a search RETURNED.
 */
export type EpisodeSourceKind = "run_turn" | "zep_episode" | "slack_message";

export type EpisodeSourceDescriptor = {
  kind: EpisodeSourceKind;
  /** Bounded trusted identifier. Never model-supplied, never a URL. */
  ref: string;
  /** Present for `run_turn`, so the D1 row can say which turn it came from. */
  turnId?: string;
};

/**
 * Where a tool read's trusted ids are written.
 *
 * Declared in this leaf module rather than next to its implementation so the
 * capability layer can depend on the INTERFACE without importing the session,
 * the Durable Object, or anything that reaches D1. The production sink lives in
 * `agent/memory.ts`.
 */
export interface ProvenanceSink {
  record(sources: readonly EpisodeSourceDescriptor[]): void;
}

/** A sink that keeps nothing, for declaration-only registries and tests. */
export function discardingProvenanceSink(): ProvenanceSink {
  return { record: () => {} };
}

export type AgentEpisodePayload = {
  episode: AgentEpisode;
  sources: EpisodeSourceDescriptor[];
};

/* ------------------------------------------------------------ redaction -- */

/**
 * Credential shapes, whatever they are called and wherever they appear.
 *
 * Deliberately a superset of `codemode/bindings/shared.ts`'s audit rule: that
 * one guards a structured argument bag with named keys, while this one guards
 * free text a customer typed into Slack. A support thread genuinely does
 * contain pasted keys, and this is the last place to catch one before it
 * becomes durable semantic memory that later answers quote back (invariant 39).
 *
 * Ordering matters only in that the `key=value` rule runs last, so a recognised
 * vendor prefix is reported as that vendor rather than as a generic assignment.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Slack: bot, user, app, refresh, and legacy tokens.
  /xox[baprse]-[A-Za-z0-9-]{8,}/g,
  // PEM private key blocks, including everything between the markers.
  /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
  // JWTs: three base64url segments. The `eyJ` head is the encoded `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization headers pasted whole.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // Vendor prefixes this system actually holds credentials for.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\blin_api_[A-Za-z0-9_-]{12,}/g,
  /\blsv2_[A-Za-z0-9_-]{12,}/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bz_[A-Za-z0-9_-]{16,}/g,
  // Anything a human labelled as a credential and then wrote down.
  /\b(?:api[_-]?key|apikey|secret|password|passwd|token|credential|authorization)\b\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
];

export const REDACTED = "[redacted]";

/**
 * Replace every credential-shaped run with a fixed marker.
 *
 * A marker rather than deletion: "the customer pasted a token here" is itself a
 * fact worth remembering, and silently closing the gap would make the sentence
 * read as though they had pasted nothing. The marker carries no entropy, so
 * nothing about the original survives it.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // A fresh regex per call: the literals above carry /g, and a shared lastIndex
    // across calls would make redaction depend on what was scanned before it.
    out = out.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return out;
}

/**
 * Collapse whitespace, redact, and hard-bound.
 *
 * Redaction runs BEFORE truncation. The other order can cut a token in half and
 * store the first half, which is still a secret and no longer matches anything.
 */
export function boundedEpisodeText(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/* -------------------------------------------------------------- actions -- */

/**
 * One line of "what the agent did", from the durable capability audit.
 *
 * Built from the capability NAME and, on failure, its stable error CODE — never
 * from the result. `slack.reply` returning a whole customer thread and
 * `slack.reply` refusing both produce one short line here, which is the
 * difference between a semantic memory and a transcript (invariant 33).
 */
export function describeAction(input: {
  name: string;
  state: "completed" | "failed";
  errorCode?: string | null;
}): string {
  const name = input.name.slice(0, 60);
  if (input.state === "completed") return name;
  const code = (input.errorCode ?? "failed").slice(0, 48);
  return `${name} refused: ${code}`;
}

/**
 * Deduplicate consecutive repeats, bound the list, and say what was dropped.
 *
 * A loop that called `supabase.query` forty times should be remembered as
 * having queried Supabase, not as forty identical lines that crowd out the one
 * `linear.createIssue` that actually mattered.
 */
export function boundActions(actions: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const raw of actions) {
    const action = boundedEpisodeText(raw, EPISODE_LIMITS.action);
    if (action.length === 0) continue;
    // Consecutive repeats only. A `linear.createIssue` between two
    // `supabase.query` runs keeps all three, because the order is the story.
    if (collapsed[collapsed.length - 1] === action) continue;
    collapsed.push(action);
  }
  if (collapsed.length <= EPISODE_LIMITS.actions) return collapsed;
  const kept = collapsed.slice(0, EPISODE_LIMITS.actions - 1);
  kept.push(`… and ${collapsed.length - kept.length} further actions`);
  return kept;
}

/* -------------------------------------------------------------- sources -- */

/** Bound the descriptor list and drop duplicates, keeping first-seen order. */
export function boundSources(
  sources: readonly EpisodeSourceDescriptor[]
): EpisodeSourceDescriptor[] {
  const seen = new Set<string>();
  const out: EpisodeSourceDescriptor[] = [];
  for (const source of sources) {
    const ref = source.ref.trim();
    // A ref is a trusted host-side identifier. An empty or absurd one is a bug
    // upstream, and storing it would produce a D1 row that resolves to nothing.
    if (ref.length === 0 || ref.length > 200) continue;
    const key = `${source.kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      source.turnId === undefined
        ? { kind: source.kind, ref }
        : { kind: source.kind, ref, turnId: source.turnId.slice(0, 200) }
    );
    if (out.length >= EPISODE_LIMITS.sources) break;
  }
  return out;
}

/* --------------------------------------------------------- the assembly -- */

export type BuildEpisodeInput = {
  runId: string;
  agentTurnId: string;
  outcome: EpisodeOutcome;
  /** The customer/user request, already selected from input turns. */
  asked: string;
  /** Capability audit lines, oldest first. */
  actions: readonly string[];
  /**
   * The SELECTED final draft, and nothing else. A caller that passes streamed
   * delta text here has defeated the exclusion rule, which is why the loop
   * hands over the same string it wrote to the durable final turn.
   */
  draft: string;
  sources: readonly EpisodeSourceDescriptor[];
};

export function buildAgentEpisode(
  input: BuildEpisodeInput
): AgentEpisodePayload {
  return {
    episode: {
      asked: boundedEpisodeText(input.asked, EPISODE_LIMITS.asked),
      actions: boundActions(input.actions),
      draft: boundedEpisodeText(input.draft, EPISODE_LIMITS.draft),
      outcome: input.outcome,
      run_id: input.runId,
      agent_turn_id: input.agentTurnId,
    },
    sources: boundSources(input.sources),
  };
}

/* ------------------------------------------------- the Zep request shape -- */

/**
 * A metadata value Zep accepts: a scalar, or a non-empty array of scalars.
 */
export type EpisodeMetadataValue = string | number | boolean | string[];
export type EpisodeMetadata = Record<string, EpisodeMetadataValue>;

/**
 * Bound metadata to Zep's verified maximum of ten scalar / non-empty
 * scalar-array tags.
 *
 * Entries are dropped rather than the call being refused. Metadata is a filter
 * hint; the episode BODY is what becomes semantic memory, and losing the whole
 * memory of a generation because an eleventh tag was added would be the wrong
 * trade. Insertion order decides, so the caller's most important tags go first.
 */
export function boundedMetadata(raw: Record<string, unknown>): EpisodeMetadata {
  const out: EpisodeMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= EPISODE_LIMITS.metadataTags) break;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      out[key] = redactSecrets(value).slice(0, 200);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const items = value
        .filter(
          (item): item is string => typeof item === "string" && item.length > 0
        )
        .map((item) => redactSecrets(item).slice(0, 200))
        .slice(0, 20);
      // A non-EMPTY scalar array. An empty one is not a supported tag value.
      if (items.length > 0) out[key] = items;
    }
    // Objects, null and undefined are not scalar tags. Dropped, never
    // stringified: `[object Object]` is a tag that means nothing and filters
    // nothing.
  }
  return out;
}

/** Bound `sourceDescription` to Zep's verified 500-character maximum. */
export function boundedSourceDescription(text: string): string {
  return boundedEpisodeText(text, EPISODE_LIMITS.sourceDescription);
}
