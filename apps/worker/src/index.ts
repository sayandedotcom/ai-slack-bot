import { Hono } from "hono";
import { slackEvents } from "./slack/events";
import { countersApi } from "./api/counters";
import { backfillApi } from "./api/backfill";
import { runsApi } from "./api/runs";
import { agentsApi } from "./api/agents";
import { approvalsApi, sweepUndeliveredApprovals } from "./api/approvals";
import { artifactsApi } from "./api/artifacts";
import { proofsApi } from "./api/proofs";
import { identityApi } from "./api/identity";
import { evalApi } from "./api/eval";
import { slackOAuth } from "./oauth/slack";
import { githubOAuth } from "./oauth/github";
import { slackRunKey } from "./run/keys";
import { routeToOwnedRun, wakeRun } from "./run/wake";
import { handleIngestBatch } from "./ingest/consumer";
import { handleMemoryBatch, type MemoryJob } from "./memory/consumer";
import { sweepMemoryOutbox } from "./memory/sweeper";
import { sweepNudges } from "./notify/nudge";
import { sweepSandboxes } from "./sandbox/lifecycle";
import { ZepMemory } from "./memory/zep";
import { subscribe } from "agents/observability";
import { handleTriageBatch, type TriageJob } from "./triage/consumer";
import { makeTriageRunner } from "./triage/run";
import type { QueuedEvent } from "./slack/types";

// The SANDBOX binding's class (Phase 18), and the SDK's own ContainerProxy.
//
// `ContainerProxy` is not decoration: the Sandbox DO resolves
// `ctx.exports.ContainerProxy` to build the fetcher that outbound interception
// runs through, so omitting this export fails at RUNTIME with "ctx.exports
// .ContainerProxy is undefined" rather than at build time. The requirement is
// stated only in a comment inside the package's `.d.ts`.
export { ContainerProxy, Sandbox } from "./sandbox/class";
export { RunAgent } from "./run/agent";
// The durable Code Mode runtime lives in a Durable Object FACET of RunAgent.
// It needs no `durable_objects.bindings` entry — nothing addresses it from
// outside — but it must be exported here AND declared in the v5 migration, or
// `ctx.exports.CodemodeRuntime` is a LoopbackServiceStub and `facets.get`
// throws "Incorrect type for the 'class' field on 'StartupOptions'".
export { CodemodeRuntime } from "@cloudflare/codemode";


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
  // Phase 12's five, all SECRETS — same justification as the AI Gateway pair
  // above: they are not in wrangler.jsonc, so `wrangler types` cannot know
  // them. Optional in the type, and that optionality is safe only because
  // every route that needs one refuses with a 503 naming the missing variable
  // (never its value) rather than proceeding without it.
  IDENTITY_KEY?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // Phase 13's three, all NON-SECRET `vars` — declared here ahead of the
  // wrangler.jsonc entries a later task adds, and optional for the same reason
  // as everything above: the code that reads them must keep treating absence as
  // possible. `sendNudge` refuses rather than guessing a destination when
  // `NUDGE_FALLBACK_CHANNEL_ID` is the one it needs and it is empty.
  /** `"dm"` (default) or `"channel"`. */
  NUDGE_MODE?: string;
  /** The #eng-firefighter channel id: used in `channel` mode, and whenever the
   *  on-duty engineer has no Slack identity row. Fallback beats silence. */
  NUDGE_FALLBACK_CHANNEL_ID?: string;
  /** Origin the nudge's "Review" button points at. */
  DASHBOARD_BASE_URL?: string;
  /**
   * Phase 19's proof-recording origin — a NON-SECRET `var`, declared here for
   * the same reason as the three above: `worker-configuration.d.ts` is
   * generated and this type must not depend on when somebody next runs
   * `cf-typegen`. It is in wrangler.jsonc alongside ARTIFACTS_BASE_URL, and
   * regenerating will simply narrow this to a required `string`.
   *
   * `${PROOFS_BASE_URL}/<64 hex>.mp4` is what `checkRecording` hands the model,
   * and it is this Worker's own origin plus `/proofs` — top level, because that
   * path is the one Cloudflare Access must BYPASS (src/api/proofs.ts).
   */
  PROOFS_BASE_URL?: string;
  /**
   * The LangSmith trace EMITTER's three settings — NON-SECRET `vars`, declared
   * here for the same reason as `PROOFS_BASE_URL` above: they are in
   * wrangler.jsonc, and regenerating `worker-configuration.d.ts` will narrow
   * both to a required `string`. The credential they spend is the existing
   * `LANGSMITH_API_KEY`, which `wrangler types` already knows.
   *
   * Optionality is safe here because `langsmithTracerConfig` treats a missing
   * or non-`"true"` flag as OFF and an unrecognised payload mode as a refusal
   * naming the variable. There is no state in which absence silently enables an
   * outbound sink.
   */
  /**
   * What one agent turn may spend, in nano-USD. A NON-SECRET `var`, declared
   * here for the same reason as the ones above.
   *
   * Optional, and absence means the reviewed default ($5.00), not unbounded —
   * `spendCeilingFrom` treats an unparseable or missing value as the default so
   * an operator typo cannot remove the money bound. An explicit `"0"` IS
   * unbounded, which is the only way to turn the ceiling off and is deliberately
   * something someone has to type.
   */
  RUN_SPEND_CEILING_NANO_USD?: string;
  /** `"none"` or `"redacted"`. Anything else is refused by name. */
  /**
   * Phase 18's read-only monorepo credential — a SECRET, so `wrangler types`
   * cannot know it, same as every entry above. Fine-grained, `web2app-rebuild`
   * only, Contents: read-only.
   *
   * It is spent in exactly ONE place: the `outboundByHost` handler in
   * `src/sandbox/class.ts`, at egress, after the request has already left the
   * container. Optional in the type because absence must stay a state the code
   * can see — the handler refuses with `configuration_incomplete` naming the
   * variable rather than fetching unauthenticated and 404ing on a private
   * repo. It must never be read anywhere a container, a capability result, an
   * audit arg or a log can reach.
   */
  MONOREPO_PAT?: string;
  /**
   * Phase 20's GitHub ship config — non-secret `vars`, same discipline as
   * `LINEAR_TEAM_ID` above: the destination pins itself server-side rather
   * than trusting a caller. Defaults live in `src/git/commit.ts`'s
   * `resolveGithubConfig`: `GITHUB_REPO` to `MONOREPO_SLUG`,
   * `GITHUB_HEAD_REPO` to `GITHUB_REPO`, `GITHUB_BASE` to `"staging"`
   * (never `"dev"` — refused at gateway construction), `GITHUB_AUTHOR` to
   * `"worker-pat"` when ABSENT — an unrecognised `GITHUB_AUTHOR` is refused by
   * name instead of coercing to that default, because the documented live-run
   * handover is "flip one var to `on-duty`" and a typo would otherwise be
   * invisible until a PR existed under the wrong identity.
   */
  GITHUB_REPO?: string;
  GITHUB_HEAD_REPO?: string;
  GITHUB_BASE?: string;
  GITHUB_AUTHOR?: string;
  /** Phase 18's dev-tier env for the monorepo's apps — a SECRET, JSON object of
   *  string to string. Read in exactly one place, `src/sandbox/env.ts`, which
   *  turns it into a per-process record; absence is a state the code can see
   *  (`devEnvFor` returns `{}`), so a deployment without it still works for
   *  everything but starting a dev server. Values must never reach a capability
   *  result, an audit arg or a log — key NAMES are fine and useful. */
  MONOREPO_DEV_ENV?: string;
  /**
   * Phase 18's monorepo install licence — a SECRET, and one that has to reach
   * the CONTAINER rather than only the build.
   *
   * `apps/dashboard` depends on `nucleo-ui-outline-18`, whose preinstall
   * verifies this key; without it a full `pnpm install` fails with
   * `ERR_PNPM_IGNORED_BUILDS`. Because `node_modules` is no longer baked into
   * the image (a 3.74 GB layer cannot be pushed from a domestic uplink), the
   * install now happens at boot, so `provision.sh` needs the key and the
   * lifecycle passes it per-process.
   *
   * Optional in the type so absence stays visible: `provision.sh` fails with a
   * named step rather than dying deep inside a preinstall script, which reads
   * like a corrupt lockfile.
   */
  NUCLEO_LICENSE_KEY?: string;
  /**
   * Phase 18's container opt-out, and the twin of `AGENT_MODEL_DISABLED` above
   * in every respect: a deliberate off switch, read strictly, and deliberately
   * NOT in wrangler.jsonc `vars` so a deployed Worker never carries it.
   *
   * Set only where there is no container runtime to reach — the vitest pool
   * binds it, because `@cloudflare/containers` throws from the `Sandbox`
   * CONSTRUCTOR when containers are not enabled and the pool reports that as an
   * unhandled rejection no `catch` at the call site can reach. See
   * `sandboxContainersAvailable` for exactly which two paths consult it, and
   * why the model-facing ones deliberately do not.
   */
  SANDBOX_DISABLED?: string;
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
app.get("/api/health", (c) => c.json({ ok: true }));

// Must stay above the catch-all below, which would otherwise swallow them.
app.route("/slack", slackEvents);
app.route("/api", countersApi);
app.route("/api", backfillApi);
app.route("/api", runsApi);
// The run transport (Phase 26). Mounted on the same `/api` as everything else,
// which is what gates the socket and the transcript read with the dashboard's
// own Access application — see `src/api/agents.ts` for why this is not
// `/agents/*` and not `routeAgentRequest`.
app.route("/api", agentsApi);
// The one human-decision surface (Phase 11). Same `/api` mount as everything
// else here, so it inherits the same Access application as the dashboard —
// `PATCH /api/approvals/:id` is exactly as gated as `GET /api/runs`.
app.route("/api", approvalsApi);
// The read side of files.publish. Under /api so it inherits the same Access
// application as the dashboard — a published artifact is exactly as private as
// the run that produced it.
app.route("/api", artifactsApi);
// Phase 12. `identityApi` is what the dashboard asks first on every load — who
// am I, and who is on duty — and the two OAuth routers are how a fire-fighter
// connects their own Slack and GitHub accounts. All three under the same /api
// mount, so the start routes inherit the same Access application as everything
// else: the browser already carries the cookie, which is the whole reason the
// connect buttons can be plain links with no JavaScript behind them.
app.route("/api", identityApi);
app.route("/api", slackOAuth);
app.route("/api", githubOAuth);
// Phase 21. Read-only, D1-only: triage precision/recall and the shadow corpus.
// Same /api mount, so it is gated by the same Access application and the same
// `requireTeamMember` roster check as `GET /api/identity` — the eval numbers are
// exactly as private as the runs they are computed from.
app.route("/api", evalApi);
// Phase 19's proof recordings. MOUNTED AT THE TOP LEVEL, NOT UNDER /api, AND
// THAT IS THE WHOLE POINT: this path must be ACCESS-BYPASSABLE. A recording URL
// is pasted into a Slack thread, and Slack's unfurler carries no Access token —
// under /api it would inherit the dashboard's Access application and answer
// every unfurl, and every customer-facing engineer outside the roster, with a
// login redirect. So `/proofs/*` gets a bypass policy on the Access application,
// the same shape `/slack/events` already has, and the 64 hex characters of the
// key are what protect the object instead. See src/api/proofs.ts for the full
// argument and for everything that guards it.
app.route("/", proofsApi);


/**
 * An unmatched API or WebSocket path is a 404, and it stops HERE — it must
 * never reach the asset bundle.
 *
 * This line exists because of Phase 14's `not_found_handling:
 * "single-page-application"` (wrangler.jsonc). That setting is what makes a
 * hard refresh on a client-side route work: the asset worker answers ANY
 * unmatched path with `index.html` and a 200. Without this guard that
 * generosity extends to `/api/anything-misspelled`, which then returns an HTML
 * document with a success status — an API caller sees 200 and gets markup,
 * and the dashboard's `getJson` maps the parse failure to "backend
 * unreachable" rather than the plain 404 it is. `test/api-artifacts.test.ts`
 * caught it: a traversal key normalizes the URL to `/api/`, which matches no
 * route, and the route's one-404-for-everything discipline silently became a
 * 200.
 *
 * Placed below every `/api` and `/ws` mount and above the catch-all, so it
 * only ever sees paths nothing else claimed.
 */
app.all("/api/*", (c) => c.json({ code: "not_found", message: "no such route" }, 404));
app.all("/ws/*", (c) => c.json({ code: "not_found", message: "no such route" }, 404));

// The Worker runs first on every request; anything unmatched falls through to
// the static asset bundle. Explicit, rather than relying on route-ordering
// config that later phases would have to keep correct.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * Think's own diagnostics, into Workers Logs.
 *
 * MODULE SCOPE, and exactly once. `subscribe` registers a process-wide listener
 * on the isolate, so calling it per request or per Durable Object would attach a
 * new one every time and print each event as many times as the isolate had
 * served requests.
 *
 * `chat` only. The SDK emits a dozen channels — rpc, mcp, fiber, schedule,
 * lifecycle — and forwarding all of them would bury the one that says why a
 * turn did not answer under traffic nobody reads.
 *
 * IDS AND STATES, NEVER CONTENT. The payload of a chat event can carry request
 * metadata, so what is logged here is the event type and the run's public id
 * where the event carries one. Message text, tool payloads and model output are
 * deliberately absent: Workers Logs is a durable sink and invariant 39 applies
 * to it exactly as it applies to a D1 row.
 */
subscribe("chat", (event) => {
  console.log("agent", { type: event.type });
});

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
          //
          // `routeToOwnedRun` absorbs a reply into the run that already owns
          // the thread — no triage call, no second model spend — and `wakeRun`
          // starts one. Both re-read the channel policy and apply the shadow
          // ratchet before any turn exists, and both are idempotent on the
          // Slack `event_id`, so a redelivered queue message submits nothing.
          routeToOwnedRun: (message) => routeToOwnedRun(env, message),
          wakeRun: async (input) => {
            await wakeRun(env, input);
          },
        });
    }
  },
  /**
   * The one-minute Cron Trigger, configured in wrangler.jsonc.
   *
   * It owns two jobs, run every minute:
   *
   *  - re-enqueueing D1 memory-outbox rows that are due, including rows whose
   *    queue delivery has already exhausted its retries and gone to the DLQ.
   *    Everything else about projection — the claim, the lease, the fence, the
   *    vendor call — belongs to the queue consumer, and duplicating any of it
   *    here would be a second implementation of a protocol that only works if
   *    there is one;
   *  - re-driving decided approvals whose resolution never reached the DO
   *    (invariant 9 / `src/api/approvals.ts`'s `sweepUndeliveredApprovals`).
   *    Same repair shape as the memory sweep: the PATCH route already
   *    committed the human decision durably, this only re-attempts the
   *    NOTIFICATION of it.
   *
   * `waitUntil` is deliberately NOT used: the sweep is the whole point of this
   * invocation, so it is awaited, and a failure should surface as a failed cron
   * run rather than as silence.
   *
   * The two sweeps run through `Promise.allSettled`, not sequential `await`s,
   * and deliberately so: a sequential `await sweepMemoryOutbox(env)` ahead of
   * `sweepUndeliveredApprovals(env)` would mean a persistently throwing memory
   * sweep silently disables the approval sweep every single minute, since
   * Cloudflare does not retry a `scheduled()` invocation on its own — and the
   * approval sweep is the ONLY repair path behind the PATCH route's
   * `200`-with-`resolutionDelivered:false` promise (invariant 9). Both sweeps
   * are always attempted; if either (or both) rejected, this still throws
   * afterward so the cron invocation is honestly reported as failed, rather
   * than swallowing the error and looking healthy.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // The third sweep (Phase 13) is the nudge retry feed: a pending card that
    // has sat unnudged for a minute — because Slack was down, or because the
    // projection's own attempt failed and handed its claim back — gets one
    // more attempt. Independent of the other two for exactly the reason stated
    // above, and safe to run beside a live projection because both go through
    // the same `claimNudge` CAS.
    //
    // The fourth sweep (Phase 18) gives back the machines. A run reaching a
    // terminal status destroys its own container, but that happens in a
    // `waitUntil` a crashed or evicted object never runs — and a container is
    // the most expensive thing this system can leak. Independent of the other
    // three for exactly the reason above: a throwing memory sweep must not be
    // what keeps a container alive for 45 minutes on `sleepAfter` alone.
    const results = await Promise.allSettled([
      sweepMemoryOutbox(env),
      sweepUndeliveredApprovals(env),
      sweepNudges(env),
      sweepSandboxes(env),
    ]);
    // The other two sweeps report their own counts from inside themselves
    // (`console.warn("memory sweep"…)`, `console.warn("approval sweep"…)`);
    // `sweepNudges` returns its count instead, so the summary line is owed
    // here. Without it the number is computed and dropped, and a paging feature
    // that pages nobody looks exactly like one with nothing to do.
    const nudges = results[2];
    if (nudges?.status === "fulfilled" && nudges.value > 0) {
      console.warn("nudge sweep", { sent: nudges.value });
    }
    // Same reasoning, and one more: this number is the only routine evidence
    // that containers are being reclaimed at all, and container-hours are what
    // this phase is spending against a fixed budget.
    const sandboxes = results[3];
    if (sandboxes?.status === "fulfilled" && sandboxes.value.destroyed > 0) {
      console.warn("sandbox sweep", { destroyed: sandboxes.value.destroyed });
    }
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        "one or more scheduled sweeps failed",
      );
    }
  },
  // The second type parameter is the queue message body. Without it,
  // ExportedHandler defaults to `unknown` and the queue handler will not typecheck.
} satisfies ExportedHandler<Env, QueuedEvent | MemoryJob | TriageJob>;
