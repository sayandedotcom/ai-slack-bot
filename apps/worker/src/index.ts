import { Hono } from "hono";
import { modelDisposition } from "./agent/ports";
import { slackEvents } from "./slack/events";
import { countersApi } from "./api/counters";
import { backfillApi } from "./api/backfill";
import { runsApi, runsWs } from "./api/runs";
import { artifactsApi } from "./api/artifacts";
import { routeSlackMessageToOwnedRun, wakeSlackRun } from "./run/coordinator";
import { handleIngestBatch } from "./ingest/consumer";
import { handleMemoryBatch, type MemoryJob } from "./memory/consumer";
import { sweepMemoryOutbox } from "./memory/sweeper";
import { ZepMemory } from "./memory/zep";
import { handleTriageBatch, type TriageJob } from "./triage/consumer";
import { makeTriageRunner } from "./triage/run";
import type { QueuedEvent } from "./slack/types";

// The named export is what the RUNS binding resolves to. Keep it above Env:
// src/run/do.ts imports Env from here, and that import must stay type-only or
// the two modules form a real cycle.
export { RunDO } from "./run/do";

/**
 * Wrangler-generated bindings, plus the two narrow refinements the application
 * genuinely needs.
 *
 * `Cloudflare.Env` in worker-configuration.d.ts is now the AUTHORITY on what
 * this Worker has. The handwritten map this replaced was a second source of
 * truth that drifted in the dangerous direction: it omitted `ARTIFACTS`,
 * `SUPABASE_KEY`, `LINEAR_API_KEY`, `LANGSMITH_API_KEY`, the Better Stack
 * credentials and every vendor pin — which is why nothing could compose the
 * capability layer for real until now, and why a composer written against it
 * would have failed at runtime rather than at `tsc`. Regenerate with
 * `pnpm --filter @workspace/worker cf-typegen` and never hand-edit the output.
 *
 * Two refinements, and only two, each because a generated type is deliberately
 * less specific than the code needs:
 *
 *  - the queue producers carry their job body types, so a `send()` with the
 *    wrong shape is a typecheck error rather than a poisoned message;
 *  - the AI Gateway secrets are declared here because they are SECRETS: they
 *    are not in wrangler.jsonc, so `wrangler types` cannot know about them.
 *    Optional in the type, and that optionality is safe only because
 *    `agent/model.ts` refuses to build a model without them — see invariant 39.
 *  - `AGENT_MODEL_DISABLED` is the explicit model opt-out read by
 *    `agent/ports.ts`. It is deliberately NOT in wrangler.jsonc `vars`: a
 *    deployed Worker must not carry it, so absence in production means "the
 *    model is supposed to work" and a missing Gateway URL fails loudly instead
 *    of parking. The local test pool sets it in vitest.config.ts.
 *
 * Note what is NOT here: no widened binding, no `[key: string]: unknown`, and
 * no re-declared platform type. `WorkerLoader`, `R2Bucket` and the rest are
 * generated platform types.
 */
export type Env = Omit<Cloudflare.Env, "MEMORY_QUEUE" | "TRIAGE_QUEUE"> & {
  MEMORY_QUEUE: Queue<MemoryJob>;
  TRIAGE_QUEUE: Queue<TriageJob>;
  AI_GATEWAY_ANTHROPIC_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  AGENT_MODEL_DISABLED?: string;
};

const app = new Hono<{ Bindings: Env }>();

/**
 * Liveness, plus THE ONE PLACE AN OPERATOR CAN SEE WHY NOTHING IS MOVING.
 *
 * `ok` stays pure liveness — an existing uptime monitor must keep meaning what
 * it meant. `model` is the composition report: `ready`, or the reason it is
 * not, by configuration NAME. Never a configured value (invariant 39), never
 * customer text, and no Durable Object is woken to produce it.
 *
 * This exists because a deployment whose model work is parked used to be
 * invisible outside one `console.warn` per isolate: the dashboard showed `live`
 * runs with `error: null` that were never going to move.
 */
app.get("/api/health", (c) => c.json({ ok: true, model: modelDisposition(c.env) }));

// Must stay above the catch-all below, which would otherwise swallow them.
app.route("/slack", slackEvents);
app.route("/api", countersApi);
app.route("/api", backfillApi);
app.route("/api", runsApi);
// The read side of files.publish. Under /api so it inherits the same Access
// application as the dashboard — a published artifact is exactly as private as
// the run that produced it.
app.route("/api", artifactsApi);
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
  /**
   * The one-minute Cron Trigger, configured in wrangler.jsonc.
   *
   * It owns exactly one job: re-enqueueing D1 memory-outbox rows that are due,
   * including rows whose queue delivery has already exhausted its retries and
   * gone to the DLQ. Everything else about projection — the claim, the lease,
   * the fence, the vendor call — belongs to the queue consumer, and duplicating
   * any of it here would be a second implementation of a protocol that only
   * works if there is one.
   *
   * `waitUntil` is deliberately NOT used: the sweep is the whole point of this
   * invocation, so it is awaited, and a failure should surface as a failed cron
   * run rather than as silence.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sweepMemoryOutbox(env);
  },
  // The second type parameter is the queue message body. Without it,
  // ExportedHandler defaults to `unknown` and the queue handler will not typecheck.
} satisfies ExportedHandler<Env, QueuedEvent | MemoryJob | TriageJob>;
