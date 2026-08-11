// Throwaway spike: one live round-trip to pin down the real V3 API surface.
// Run: ZEP_API_KEY=... pnpm tsx scripts/zep-spike.ts
import { ZepClient } from "@getzep/zep-cloud";

const zep = new ZepClient({ apiKey: process.env.ZEP_API_KEY! });
const graphId = `spike-${Date.now()}`;

async function main() {
  const created = await zep.graph.create({ graphId, name: "spike graph" });
  console.log("create ->", JSON.stringify(created));

  const episode = await zep.graph.add({
    graphId,
    type: "message",
    data: "priya: checkout is broken on the pricing page again",
  });
  console.log("add ->", JSON.stringify(episode));
  // Record: what is the episode UUID field called? episode.uuid? episode.uuid_?

  // Zep ingests asynchronously; give it a moment before searching.
  await new Promise((r) => setTimeout(r, 15000));

  const results = await zep.graph.search({
    graphId,
    query: "checkout problems",
    scope: "edges",
    limit: 5,
  });
  console.log("search ->", JSON.stringify(results, null, 2));
  // Record: edge fields (uuid? fact? episodes?) and whether min_score is rejected.
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e);
  process.exit(1);
});
