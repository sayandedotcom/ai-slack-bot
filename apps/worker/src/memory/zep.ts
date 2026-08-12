import { ZepClient } from "@getzep/zep-cloud";
import type { AddEpisodeInput, MemoryFact, MemoryStore } from "./store";

/**
 * The wall-time ceiling on ONE Zep request.
 *
 * It exists so the outbox lease can be strictly longer than it (see
 * `OUTBOX_LEASE_MS`). Without an enforced ceiling there is no upper bound on
 * how long a claimant can be inside `graph.add`, and therefore no lease length
 * that can honestly be called "longer than the request".
 */
export const ZEP_REQUEST_TIMEOUT_SECONDS = 20;

/**
 * Real Zep V3 client. Graph existence is cached per isolate so the common
 * path costs zero extra round-trips; the cache resets on isolate recycle,
 * which just means one redundant idempotent create.
 *
 * Every shape here was confirmed by a live round-trip — see phase-06-notes.md —
 * and re-confirmed for `graph.add`'s metadata/sourceDescription fields against
 * the installed 3.27.0 declarations and the Zep docs MCP in Phase 10 Task 9.
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

  /**
   * The one vendor write.
   *
   * `maxRetries: 0` is the load-bearing option here, and it is a REDUCTION from
   * the SDK's default of 2. `graph.add` accepts no idempotency key, so an SDK
   * retry of a request that actually succeeded but whose response was lost
   * creates a second semantic episode that nothing in this system ever learns
   * about — a duplicate with no D1 trace at all. Retrying is the outbox's job,
   * where an attempt is durable, counted, and bounded. Letting the transport
   * layer do it silently would widen the documented duplicate window for no
   * gain.
   *
   * `timeoutInSeconds` is enforced for the same reason the lease exists: an
   * unbounded call is an unbounded lease requirement.
   */
  async addEpisode(input: AddEpisodeInput): Promise<{ episodeUuid: string }> {
    await this.ensureGraph(input.graphId);
    const episode = await this.client.graph.add(
      {
        graphId: input.graphId,
        type: input.type,
        data: input.data,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.sourceDescription === undefined
          ? {}
          : { sourceDescription: input.sourceDescription }),
      },
      { timeoutInSeconds: ZEP_REQUEST_TIMEOUT_SECONDS, maxRetries: 0 },
    );
    return { episodeUuid: episode.uuid };
  }

  /**
   * Kept as a convenience wrapper rather than migrated away, because its two
   * callers (the message consumer and triage) are correct as they are and
   * rewriting them would be churn in files this task has no other reason to
   * touch. It is now a wrapper over `addEpisode`, so there is exactly one place
   * where a Zep write happens.
   */
  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    return this.addEpisode({ graphId, type: "message", data });
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
