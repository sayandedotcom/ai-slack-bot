import type { EpisodeMetadata } from "./episode";

export type MemoryFact = {
  /** The Zep edge UUID — opaque handle a caller passes back to cite(). */
  factId: string;
  fact: string;
  /** Source episode UUIDs; cite() resolves these through zep_episodes. */
  episodeUuids: string[];
};

/**
 * One ingestion, in the exact shape Zep V3's `graph.add` accepts.
 *
 * Verified against the installed `@getzep/zep-cloud@3.27.0` declarations and
 * the Zep documentation MCP on 2026-08-13:
 *
 *  - `metadata` is `Max 10 keys. Values must be strings, numbers, booleans, or
 *    arrays of scalars`, and empty arrays are rejected;
 *  - `source_description` carries an explicit `<=500 characters` constraint in
 *    the REST reference which Fern DROPS from the generated TypeScript, so it
 *    is server-enforced only and must be bounded by us;
 *  - there is NO client-supplied episode id, uuid, or idempotency key on
 *    `AddDataRequest` — the complete body is `data`, `type`, `createdAt?`,
 *    `graphId?`, `metadata?`, `sourceDescription?`, `strictOntology?`,
 *    `userId?`. That absence is why the projector claims a D1 row before
 *    calling, and why delivery is honestly at-least-once. See `consumer.ts`.
 */
export type AddEpisodeInput = {
  graphId: string;
  /** `"json"` for an agent episode; `"message"` for a projected Slack message. */
  type: "json" | "message" | "text";
  /** Already bounded and already redacted. This seam does neither. */
  data: string;
  metadata?: EpisodeMetadata;
  sourceDescription?: string;
};

/**
 * The one seam between the app and Zep. Consumers, triage, and the Phase 09
 * `memory` binding all program against this; only zep.ts knows the SDK.
 */
export interface MemoryStore {
  ensureGraph(graphId: string): Promise<void>;
  /**
   * The generic ingestion. Everything else in this interface that writes is a
   * convenience wrapper over it, so there is one place a vendor call happens.
   */
  addEpisode(input: AddEpisodeInput): Promise<{ episodeUuid: string }>;
  /** The shipped Phase 06 message projection, unchanged for its callers. */
  addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }>;
  search(graphId: string, query: string, limit?: number): Promise<MemoryFact[]>;
}
