import type { MemoryStore } from "../memory/store";

/**
 * The narrow interfaces the capability layer talks to, and the shapes it hands
 * back to model-authored code.
 *
 * Providers receive these, never the Worker `env`. Two consequences that are
 * the whole point:
 *
 *  - credentials live in the gateway implementation, so a binding file has no
 *    way to reach one even by accident;
 *  - credential *absence* is testable with a fake, so Tasks 6-12 can be written
 *    and reviewed without a live vendor account.
 *
 * Field names here become model-visible type names. Nothing in this file may
 * name a target, an identity, or a credential — `renderCapabilityDeclarations`
 * has a test that greps the generated declarations for exactly that.
 */

/* ------------------------------------------------------------ result shapes -- */

export type SlackMessage = {
  ts: string;
  userId: string | null;
  text: string;
  permalink: string | null;
};

export type RecalledFact = {
  factId: string;
  fact: string;
};

/**
 * `channel_id` from the Phase 06 citation resolver is deliberately dropped on
 * the way out: it is a destination identifier, and the model is never shown
 * one. The permalink already points at the exact message.
 */
export type Citation = {
  factId: string;
  fact: string;
  permalink: string;
  ts: string;
};

export type IssueRef = {
  id: string;
  identifier: string;
  url: string;
};

export type ResourceDescription = {
  resource: string;
  columns: Array<{ name: string; type: string }>;
};

/** One row of an allowlisted read. Scalars only — see toSafeJson's depth cap. */
export type Row = Record<string, string | number | boolean | null>;

export type TraceRef = {
  traceId: string;
  name: string;
  startedAt: string;
  status: string;
};

/**
 * A FLAT node list with parent links, never a nested tree.
 *
 * `JsonValue` bottoms out after four levels, so a freely nested tree cannot
 * survive `RunDO.appendToolCallUpdate({ output })` — and that failure is a
 * typecheck error no test can observe, because vitest strips types. Flat is
 * also cheaper to truncate and reconstructible in three lines of model code.
 */
export type TraceNode = {
  id: string;
  parentId: string | null;
  name: string;
  runType: string;
  status: string;
  startedAt: string;
  durationMs: number;
  /** Bounded preview, not the full prompt. */
  inputPreview: string;
  outputPreview: string;
  error: string | null;
};

export type Trace = {
  traceId: string;
  name: string;
  startedAt: string;
  status: string;
  nodes: TraceNode[];
  /** True when nodes were dropped to fit the caps. */
  truncated: boolean;
};

export type LogLine = {
  at: string;
  level: string;
  message: string;
};

export type Monitor = {
  id: string;
  name: string;
  status: string;
  lastCheckedAt: string | null;
};

export type PublishedFile = {
  url: string;
  size: number;
  sha256: string;
};

/* ---------------------------------------------------------------- gateways -- */

export interface SlackGateway {
  /** The current run's conversation, from the D1 system of record. */
  thread(limit: number): Promise<SlackMessage[]>;
  /**
   * `customerSlug` is a REQUIRED argument, not an optional override, and it is
   * always a slug the trusted parent resolved — from the run's own D1 channel
   * policy, or from a reference the host minted after reading the catalog. The
   * gateway can therefore no longer read `scope.customerSlug` itself, which is
   * what makes the Chat discovery path expressible without giving the gateway a
   * second, quieter way to pick a customer.
   */
  searchMessages(
    query: string,
    limit: number,
    customerSlug: string,
  ): Promise<SlackMessage[]>;
  /** Post into the current run only. Targeting is not a parameter. */
  reply(text: string, idempotencyKey: string): Promise<{ ts: string; permalink: string | null }>;
}


export interface LinearGateway {
  createIssue(input: {
    title: string;
    description: string;
    labels: string[];
    idempotencyKey: string;
  }): Promise<IssueRef>;
  /**
   * Did the issue for this key actually get filed?
   *
   * Answerable precisely because the create supplies its own id, so this is an
   * exact lookup rather than a guess. It is what turns an ambiguous 5xx into a
   * decidable question instead of permanent doubt.
   */
  findIssue(idempotencyKey: string): Promise<IssueRef | null>;
  updateIssue(input: {
    issueId: string;
    title?: string;
    description?: string;
    state?: string;
  }): Promise<{ id: string; url: string }>;
}

export interface SupabaseReader {
  describe(resource: string | null): Promise<ResourceDescription[]>;
  select(input: {
    resource: string;
    columns: string[] | null;
    filters: Array<{ column: string; op: string; value: unknown }>;
    order: { column: string; direction: "asc" | "desc" } | null;
    limit: number;
  }): Promise<Row[]>;
}

export interface LangSmithReader {
  trace(traceId: string): Promise<Trace>;
  searchTraces(input: {
    query: string | null;
    since: string | null;
    limit: number;
  }): Promise<TraceRef[]>;
}

export interface BetterStackReader {
  logs(input: {
    query: string;
    since: string;
    until: string | null;
    limit: number;
  }): Promise<LogLine[]>;
  monitors(): Promise<Monitor[]>;
}

export interface ArtifactPublisher {
  publish(input: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    idempotencyKey: string;
  }): Promise<PublishedFile>;
}

/**
 * Everything a capability may reach. Deliberately not `Env`: a binding file
 * that wanted a credential would have to change this type first, in a diff.
 */
export type CapabilityDependencies = {
  db: D1Database;
  slack: SlackGateway;
  /** The shipped Phase 06 seam, reused rather than paralleled. */
  memory: MemoryStore;
  linear: LinearGateway;
  supabase: SupabaseReader;
  langsmith: LangSmithReader;
  betterstack: BetterStackReader;
  files: ArtifactPublisher;
  clock: () => number;
};
