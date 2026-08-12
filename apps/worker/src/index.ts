import { Hono } from "hono";
import { slackEvents } from "./slack/events";
import { countersApi } from "./api/counters";
import { backfillApi } from "./api/backfill";
import { runsApi, runsWs } from "./api/runs";
import { routeSlackMessageToOwnedRun, wakeSlackRun } from "./run/coordinator";
import { handleIngestBatch } from "./ingest/consumer";
import { handleMemoryBatch, type MemoryJob } from "./memory/consumer";
import { ZepMemory } from "./memory/zep";
import { handleTriageBatch, type TriageJob } from "./triage/consumer";
import { makeTriageRunner } from "./triage/run";
import type { QueuedEvent } from "./slack/types";

// The named export is what the RUNS binding resolves to. Keep it above Env:
// src/run/do.ts imports Env from here, and that import must stay type-only or
// the two modules form a real cycle.
export { RunDO } from "./run/do";

export type Env = {
  DB: D1Database;
  RUNS: DurableObjectNamespace<import("./run/do").RunDO>;
  INGEST_QUEUE: Queue;
  MEMORY_QUEUE: Queue<MemoryJob>;
  TRIAGE_QUEUE: Queue<TriageJob>;
  ASSETS: Fetcher;
  // Worker Loader (Phase 09). WorkerLoader is a generated platform type from
  // worker-configuration.d.ts -- never redeclare it by hand.
  LOADER: WorkerLoader;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ZEP_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  // The private AI Gateway the agent's Fable calls are routed through. Optional
  // in the type because the Gateway does not exist yet; the agent's production
  // composer refuses to build a model without it (see agent/model.ts), so the
  // optionality can never become a quiet direct-to-Anthropic call.
  AI_GATEWAY_ANTHROPIC_URL?: string;
  // Cloudflare API token with AI Gateway `Run`, sent as `cf-aig-authorization`
  // on provider-native Gateway endpoints. A Worker SECRET: it is never written
  // to wrangler.jsonc, docs, generated types, or a test snapshot.
  AI_GATEWAY_TOKEN?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Must stay above the catch-all below, which would otherwise swallow them.
app.route("/slack", slackEvents);
app.route("/api", countersApi);
app.route("/api", backfillApi);
app.route("/api", runsApi);
// Not JSON, so it is mounted outside /api — but still above the asset
// catch-all, and still behind the same Access application as the dashboard.
app.route("/ws", runsWs);

// The Worker runs first on every request; anything unmatched falls through to
// the static asset bundle. Explicit, rather than relying on route-ordering
// config that later phases would have to keep correct.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // One handler serves every queue; `batch.queue` is the only thing that says
  // which one delivered. A new queue that forgets a case here fails silently.
  async queue(batch: MessageBatch<QueuedEvent | MemoryJob | TriageJob>, env: Env): Promise<void> {
    switch (batch.queue) {
      case "firefighter-ingest":
        return handleIngestBatch(batch as MessageBatch<QueuedEvent>, env);
      case "firefighter-memory":
        return handleMemoryBatch(batch as MessageBatch<MemoryJob>, env, new ZepMemory(env.ZEP_API_KEY));
      case "firefighter-triage":
        return handleTriageBatch(batch as MessageBatch<TriageJob>, env, {
          triage: makeTriageRunner(env),
          memory: new ZepMemory(env.ZEP_API_KEY),
          // No HTTP self-call and no extra queue: the consumer and the
          // coordinator both run in the trusted parent Worker.
          routeToOwnedRun: (message) => routeSlackMessageToOwnedRun(env, message),
          wakeRun: async (input) => {
            await wakeSlackRun(env, input);
          },
        });
    }
  },
  // The second type parameter is the queue message body. Without it,
  // ExportedHandler defaults to `unknown` and the queue handler will not typecheck.
} satisfies ExportedHandler<Env, QueuedEvent | MemoryJob | TriageJob>;
