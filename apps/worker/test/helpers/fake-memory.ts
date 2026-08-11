import type { MemoryFact, MemoryStore } from "../../src/memory/store";

let uuidCounter = 0;

export class FakeMemoryStore implements MemoryStore {
  graphs = new Set<string>();
  episodes: { graphId: string; data: string; episodeUuid: string }[] = [];
  searchResults: MemoryFact[] = [];
  failNextAdd = false;

  async ensureGraph(graphId: string): Promise<void> {
    this.graphs.add(graphId);
  }

  async addMessage(graphId: string, data: string): Promise<{ episodeUuid: string }> {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error("zep unavailable");
    }
    const episodeUuid = `ep-${++uuidCounter}`;
    this.episodes.push({ graphId, data, episodeUuid });
    return { episodeUuid };
  }

  async search(): Promise<MemoryFact[]> {
    return this.searchResults;
  }
}
