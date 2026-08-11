import { Hono } from "hono";
import { slackEvents } from "./slack/events";

export type Env = {
  DB: D1Database;
  INGEST_QUEUE: Queue;
  ASSETS: Fetcher;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Must stay above the catch-all below, which would otherwise swallow it.
app.route("/slack", slackEvents);

// The Worker runs first on every request; anything unmatched falls through to
// the static asset bundle. Explicit, rather than relying on route-ordering
// config that later phases would have to keep correct.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Phase 04 fills this in.
    void batch;
    void env;
  },
} satisfies ExportedHandler<Env>;
