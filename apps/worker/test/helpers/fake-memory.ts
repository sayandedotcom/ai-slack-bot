import type { AddEpisodeInput, MemoryFact, MemoryStore } from "../../src/memory/store";

let uuidCounter = 0;

export class FakeMemoryStore implements MemoryStore {
  graphs = new Set<string>();
  episodes: {
    graphId: string;
    data: string;
    episodeUuid: string;
    type?: AddEpisodeInput["type"];
    metadata?: AddEpisodeInput["metadata"];
    sourceDescription?: string;
  }[] = [];
  searchResults: MemoryFact[] = [];
  failNextAdd = false;

  async ensureGraph(graphId: string): Promise<void> {
    this.graphs.add(graphId);
  }

  async addEpisode(input: AddEpisodeInput): Promise<{ episodeUuid: string }> {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error("zep unavailable");
    }
    this.graphs.add(input.graphId);
    const episodeUuid = `ep-${++uuidCounter}`;
    this.episodes.push({
      graphId: input.graphId,
      data: input.data,
      episodeUuid,
      type: input.type,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.sourceDescription === undefined
        ? {}
        : { sourceDescription: input.sourceDescription }),
    });
    return { episodeUuid };
  }

  /** Mirrors the production wrapper: addMessage is addEpisode with type message. */
  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    return this.addEpisode({ graphId, type: "message", data });
  }

  async search(): Promise<MemoryFact[]> {
    return this.searchResults;
  }
}
