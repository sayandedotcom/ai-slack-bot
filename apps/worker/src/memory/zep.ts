import { ZepClient } from "@getzep/zep-cloud";
import type { MemoryFact, MemoryStore } from "./store";

/**
 * Real Zep V3 client. Graph existence is cached per isolate so the common
 * path costs zero extra round-trips; the cache resets on isolate recycle,
 * which just means one redundant idempotent create.
 *
 * Every shape here was confirmed by a live round-trip — see phase-06-notes.md.
 * Two things worth knowing before editing: the SDK camelCases request fields
 * the REST docs show in snake_case, and `graph.add` returning an episode does
 * NOT mean the fact is searchable — extraction lags by minutes.
 */
export class ZepMemory implements MemoryStore {
  private client: ZepClient;
  private known = new Set<string>();

  constructor(apiKey: string) {
    this.client = new ZepClient({ apiKey });
  }

  async ensureGraph(graphId: string): Promise<void> {
    if (this.known.has(graphId)) return;
    try {
      await this.client.graph.create({ graphId, name: graphId });
    } catch (e: unknown) {
      // Already-exists is success; anything else is a real failure. Live, a
      // duplicate create is a 400 whose body still says "group already exists"
      // — V3 renamed groups to graphs but the error text did not follow.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/exist|conflict|400|409/i.test(msg)) throw e;
    }
    this.known.add(graphId);
  }

  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    await this.ensureGraph(graphId);
    const episode = await this.client.graph.add({ graphId, type: "message", data });
    return { episodeUuid: episode.uuid };
  }

  async search(graphId: string, query: string, limit = 8): Promise<MemoryFact[]> {
    const res = await this.client.graph.search({ graphId, query, scope: "edges", limit });
    return (res.edges ?? []).map((edge) => ({
      factId: edge.uuid,
      fact: edge.fact,
      episodeUuids: edge.episodes ?? [],
    }));
  }
}
