# Phase 06 — Zep V3 API notes (from the live spike)

Raw material for the README's AI-tool notes. Everything below was confirmed
against `@getzep/zep-cloud@3.27.0` and a live round-trip on 2026-08-11, not
from the model's memory.

## Confirmed signatures

The TypeScript SDK is Fern-generated and **camelCases every request field**
(`graphId`, not `graph_id`), while the REST docs and the raw JSON bodies use
snake_case. Reading the docs and typing what you see there produces code that
does not compile.

```ts
import { ZepClient } from "@getzep/zep-cloud";   // named export; docs show `Zep`
const zep = new ZepClient({ apiKey });

zep.graph.create({ graphId, name?, description?, timeZone? })   // -> Zep.Graph
zep.graph.add({ graphId?, userId?, data, type, metadata? })     // -> Zep.Episode
zep.graph.search({ query, graphId?, userId?, scope?, limit?, reranker?, ... })
                                                                // -> Zep.GraphSearchResults
```

- `type` is `GraphDataType = "text" | "json" | "message" | "fact_triple"`.
- `scope` is `GraphSearchScope = "edges" | "nodes" | "episodes" | "thread_summaries" | "observations" | "auto"`, defaulting to `edges`.
- `limit` is capped at 50 server-side.
- Exactly one of `graphId` / `userId` — both are optional in the type, so
  passing neither typechecks and fails at runtime.

### The episode UUID field is `uuid`

The load-bearing question for the `zep_episodes` mapping. Live `graph.add`:

```json
{"content":"priya: checkout is broken on the pricing page again",
 "uuid":"a91cd483-cd08-4e3a-8ac7-05547af59a1c","source":"message",
 "sourceDescription":"","createdAt":"2026-08-11T10:45:42.339902Z",
 "processed":false,"session_id":null}
```

`Episode.uuid` is **non-optional** in the type (`uuid: string`), as are
`EntityEdge.uuid` and `EntityEdge.fact`. The `?? ""` fallbacks the model wrote
around all three are dead code — kept only where they cost nothing.

### The citation chain is real

`EntityEdge.episodes` is a list of **episode UUIDs**, and it contained exactly
the UUID `graph.add` had returned:

```json
{"uuid":"5928ad07-...","fact":"The checkout is located on the pricing page.",
 "name":"IS_LOCATED_ON","scope":"entity",
 "episodes":["a91cd483-cd08-4e3a-8ac7-05547af59a1c"],
 "score":0.032522473,"graph_id":"", ...}
```

This is what makes `cite()` possible: edge → `episodes[]` → `zep_episodes` →
`event_id` → stored permalink. Confirmed, not assumed.

## Ingestion latency: minutes, not seconds

**The one finding that changes the design's expectations.** `graph.add` returns
in well under a second and the episode is immediately listable — but it comes
back `processed: false`, and no edges exist until Zep's extraction pipeline runs.
Measured on the spike graph:

| t (after add) | `processed` | edges |
| ------------- | ----------- | ----- |
| 15s – 105s    | false       | 0     |
| t+0 … t+150s  | false       | 0     |
| **t+180s**    | **true**    | **2** |

End to end: **~5.5 minutes** from `graph.add` to a searchable fact. The plan's
exit criterion "appears in `customer:{slug}` within seconds" holds only for the
*episode write and the `zep_episodes` row* — which is what our code controls and
what the queue consumer is measured on. Fact *recall* lags by minutes, on Zep's
side, and no amount of retrying on our end shortens it. Phase 07's triage must
not assume a message it just ingested is already recallable as a fact.

## V2-shaped and invented APIs the model produced

Recorded per the plan; this is the AI-tool-notes raw material.

1. **`min_score` on `graph.search` is not rejected — it is silently ignored.**
   The plan predicted a hard rejection after the Feb 2026 deprecation wave.
   Passing `min_score: 0.5` returned `200` with normal results. This is the worse
   failure mode: V2-shaped filtering code keeps "working" while silently
   filtering nothing. There is no `min_score` in `GraphSearchQuery`; the only
   score control is `reranker` plus post-filtering on `edge.score` yourself.
2. **`groups` → `graphs`.** V3 renamed the concept, but the server still speaks
   V2 underneath: a duplicate `graph.create` fails with
   `bad request: group already exists with group_id: <id>` — a *group* error for
   a *graph* call. Error-matching code has to tolerate both vocabularies.
3. **Duplicate `create` throws `BadRequestError` with status 400**, not a 409
   Conflict as the model assumed. `ZepMemory.ensureGraph`'s
   `/exist|conflict|400|409/i` test matches the live message, verified.
4. **`graph.edge.getByGraphId()` throws on a graph with no edges** —
   `JsonError: Expected object. Received undefined.` from the SDK's own
   deserializer, rather than returning an empty list. An SDK bug, not a usage
   error. Avoided: we only ever read edges through `graph.search`, which
   correctly returns `edges: []`.
5. **Snake_case leaks through the camelCase types.** Live payloads carry
   `session_id` (episodes) and `graph_id` (edges) — fields absent from the
   generated TS interfaces, so they are invisible to the compiler. Notably
   `graph_id` came back as `""` on an edge from a graph whose id is
   `spike-1786445141164`; don't trust it for routing.
6. **`ZepClient` vs `Zep`.** The docs' TypeScript samples instantiate `Zep`;
   the package's actual named export is `ZepClient` (`Zep` is the *namespace* of
   types). Copying the docs verbatim yields an undefined constructor.

## Method used

Docs MCP (`zep-docs`) for prose and REST shapes, then the installed package's
generated `.d.ts` files as the authority for TypeScript shapes, then one live
round-trip to settle the runtime behaviour the types cannot express (latency,
duplicate-create error text, `min_score` tolerance). The `.d.ts` files resolved
several questions the docs left ambiguous; the live run overturned one thing
both of them implied.
