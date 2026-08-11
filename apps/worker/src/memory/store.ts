export type MemoryFact = {
  /** The Zep edge UUID — opaque handle a caller passes back to cite(). */
  factId: string;
  fact: string;
  /** Source episode UUIDs; cite() resolves these through zep_episodes. */
  episodeUuids: string[];
};

/**
 * The one seam between the app and Zep. Consumers, triage, and the Phase 09
 * `memory` binding all program against this; only zep.ts knows the SDK.
 */
export interface MemoryStore {
  ensureGraph(graphId: string): Promise<void>;
  addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }>;
  search(graphId: string, query: string, limit?: number): Promise<MemoryFact[]>;
}
