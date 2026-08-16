import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { modelDisposition } from "./agent/ports";
import { slackEvents } from "./slack/events";
import { countersApi } from "./api/counters";
import { backfillApi } from "./api/backfill";
import { runsApi, runsWs } from "./api/runs";
import { approvalsApi, sweepUndeliveredApprovals } from "./api/approvals";
import { artifactsApi } from "./api/artifacts";
import { proofsApi } from "./api/proofs";
import { identityApi } from "./api/identity";
import { evalApi } from "./api/eval";
import { slackOAuth } from "./oauth/slack";
import { githubOAuth } from "./oauth/github";
import { routeSlackMessageToOwnedRun } from "./run/coordinator";
import { resolveChassis, wakeRun as wakeRunOnActiveChassis } from "./run/chassis";
import { assertRunKey, slackRunKey } from "./run/keys";
import { getRunById } from "./run/repository";
import { handleIngestBatch } from "./ingest/consumer";
import { handleMemoryBatch, type MemoryJob } from "./memory/consumer";
import { sweepMemoryOutbox } from "./memory/sweeper";
import { sweepNudges } from "./notify/nudge";
import { sweepSandboxes } from "./sandbox/lifecycle";
import { ZepMemory } from "./memory/zep";
import { handleTriageBatch, type TriageJob } from "./triage/consumer";
import { makeTriageRunner } from "./triage/run";
import type { QueuedEvent } from "./slack/types";

// The named export is what the RUNS binding resolves to. Keep it above Env:
// src/run/do.ts imports Env from here, and that import must stay type-only or
// the two modules form a real cycle.
export { RunDO } from "./run/do";

// The SANDBOX binding's class (Phase 18), and the SDK's own ContainerProxy.
//
// `ContainerProxy` is not decoration: the Sandbox DO resolves
// `ctx.exports.ContainerProxy` to build the fetcher that outbound interception
// runs through, so omitting this export fails at RUNTIME with "ctx.exports
// .ContainerProxy is undefined" rather than at build time. The requirement is
// stated only in a comment inside the package's `.d.ts`.
export { ContainerProxy, Sandbox } from "./sandbox/class";

// Phase 25. The durable codemode runtime behind the execute tool is a FACET of
// whichever Durable Object created the tool, resolved by name off the entry's
// own `exports` map — `ctx.facets.get("codemode:<name>", () => ({ class:
// ctx.exports.CodemodeRuntime }))`. Omitting this export throws at
// tool-construction time rather than at build time: exactly the same shape of
// trap as ContainerProxy above, and stated only in a comment inside the
// package's `.d.ts`.
//
// This export is HALF the requirement, and the docs only mention this half.
// `CodemodeRuntime` must ALSO be declared as a Durable Object class in
// wrangler.jsonc's `migrations` (tag `v3`), or `ctx.exports.CodemodeRuntime` is
// a plain service stub that `facets.get` rejects. See the comment on that tag
// for the exact error, and docs/superpowers/plans/phase-25-notes.md for the
// spike that measured it. No binding: nothing addresses the runtime from
// outside its host DO.
export { CodemodeRuntime } from "@cloudflare/codemode";

// Phase 25. The run session on the Think chassis, live BESIDE `RunDO` behind
// the `RUN_CHASSIS` var for the strangler window. `wrangler deploy` refuses a
// `durable_objects.bindings` entry whose class is not exported here, so this
// line is what makes the tree deployable again after Task 1 added the binding.
export { RunAgent } from "./run/agent";

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
  /**
   * Phase 25's Think-chassis binding, RETYPED. `wrangler types` emits it as a
   * bare `DurableObjectNamespace` (it cannot see a class it is not told about),
   * and the generic is what gives every call site the agent's RPC surface —
   * exactly as `RUNS` carries `RunDO`. A type-only import so this module and
   * `src/run/agent.ts` never form a real cycle.
   */
  RUN_AGENTS: DurableObjectNamespace<import("./run/agent").RunAgent>;
  /**
   * Which chassis a wake resolves to — a non-secret `var` pinned in
   * wrangler.jsonc, restated here to NAME its two legal values where every
   * reader will look.
   *
   * Deliberately not narrowed to the bare literal union. `Env` is an
   * intersection over `Cloudflare.Env`, which types this `string`, and dozens
   * of existing tests hand the pool's raw `Cloudflare.Env` to functions taking
   * `Env` — narrowing here makes that assignment illegal everywhere at once
   * for no safety gained, because the value arrives from a config file at
   * runtime either way. `src/run/chassis.ts` (Task 12) is the ONE place it is
   * read, and that is where an unrecognised value is refused by name.
   */
  RUN_CHASSIS?: "think" | "legacy" | (string & {});
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
app.get("/api/health", (c) => c.json({ ok: true, model: modelDisposition(c.env) }));

// Must stay above the catch-all below, which would otherwise swallow them.
app.route("/slack", slackEvents);
app.route("/api", countersApi);
app.route("/api", backfillApi);
app.route("/api", runsApi);
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
// Not JSON, so it is mounted outside /api — but still above the asset
// catch-all, and still behind the same Access application as the dashboard.
app.route("/ws", runsWs);

/**
 * Which session chassis is live, so the SPA can mount the matching view.
 *
 * The dashboard ships BOTH views for the length of the strangler window: the
 * legacy `/ws` transcript and the `useAgentChat` one. Nothing in the bundle can
 * know which chassis a given deployment runs — `RUN_CHASSIS` is a wrangler
 * `var`, not a build input, and baking it into the SPA would mean a chassis
 * flip needs a dashboard rebuild rather than a `wrangler deploy`. So the
 * browser asks.
 *
 * D1-free, DO-free, and it names the variable rather than echoing an
 * unrecognised value (invariant 39's rule applied uniformly). Under /api so it
 * inherits the same Access application as everything else.
 */
app.get("/api/chassis", (c) => {
  try {
    return c.json({ chassis: resolveChassis(c.env) });
  } catch {
    return c.json(
      { code: "invalid_chassis", message: "RUN_CHASSIS is not a recognised value" },
      500,
    );
  }
});

/**
 * Phase 25. The Agents SDK's own transport for `RunAgent` — the WebSocket the
 * dashboard's `useAgentChat` speaks, plus the `/get-messages` HTTP read behind
 * it.
 *
 * MOUNTED AT THE TOP LEVEL AND DELIBERATELY *NOT* BYPASSED. Read the comment
 * on `/proofs/*` below: that route is the ONE path in this Worker that Cloudflare
 * Access must let through unauthenticated, and it stays the only one. `/agents/*`
 * is a new top-level path on the same origin, so the dashboard's Access
 * application covers it by default — exactly like `/ws`, which is the socket
 * this one replaces and which is likewise gated by the application and absent
 * from its bypass policy. Adding a bypass for `/agents/*` would hand an
 * anonymous caller a live steer channel into a customer-facing run.
 *
 * TWO things happen here before `routeAgentRequest` sees the request, and both
 * are load-bearing:
 *
 *  1. **The chassis check.** `routeAgentRequest` would happily boot a `RunAgent`
 *     for a run the legacy chassis owns, giving the operator an empty transcript
 *     for a run that is very much alive in `RunDO`. Refused by name instead.
 *
 *  2. **The id→key resolution.** `routePartykitRequest` names the Durable Object
 *     with `idFromName(<third path segment>)` — verbatim, undecoded. Letting the
 *     browser put that segment there directly would make the public URL a DO
 *     name, which is exactly what invariant 10 forbids: `runs.id` is a UUID and
 *     the `slack:{channel}:{thread_ts}` key is resolved through D1, server-side,
 *     never string-built from anything a client sent. So the browser addresses
 *     `/agents/run-agents/{runs.id}`, D1 answers with the key, and the path is
 *     rewritten before routing. A caller who guesses a raw key gets a 404 from
 *     `getRunById`, because a key is not an id.
 *
 * `run-agents` is `camelCaseToKebabCase("RUN_AGENTS")` — partyserver derives the
 * namespace segment from the BINDING name in wrangler.jsonc, not from the class.
 */
const AGENT_NAMESPACE = "run-agents";

app.all("/agents/*", async (c) => {
  let chassis: string;
  try {
    chassis = resolveChassis(c.env);
  } catch {
    return c.json(
      { code: "invalid_chassis", message: "RUN_CHASSIS is not a recognised value" },
      500,
    );
  }
  if (chassis !== "think") {
    return c.json(
      { code: "chassis_not_active", message: "this deployment runs the legacy run chassis" },
      404,
    );
  }

  // ["agents", "<namespace>", "<runs.id>", ...rest]. `rest` is preserved
  // verbatim: `useAgentChat` reads the transcript from `<room>/get-messages`.
  const url = new URL(c.req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const namespace = segments[1];
  const runId = segments[2];
  if (namespace !== AGENT_NAMESPACE || runId === undefined || runId === "") {
    return c.json({ code: "not_found", message: "no such agent route" }, 404);
  }

  const run = await getRunById(c.env.DB, decodeURIComponent(runId));
  if (!run) return c.json({ code: "not_found", message: "no such run" }, 404);

  let key: string;
  try {
    // Re-validated before it names an object, exactly as `runStubForKey` and
    // `wakeRun` do — a corrupted `runs.key` must not conjure an anonymous agent.
    key = assertRunKey(run.key);
  } catch {
    return c.json({ code: "invalid_run_key", message: "this run cannot be addressed" }, 500);
  }

  segments[2] = key;
  url.pathname = `/${segments.join("/")}`;
  const routed = await routeAgentRequest(new Request(url, c.req.raw), c.env);
  return routed ?? c.json({ code: "not_found", message: "no such agent route" }, 404);
});

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
          // THE wake, for both chassis. `src/run/chassis.ts` is the only reader
          // of `RUN_CHASSIS`; the legacy branch is still `wakeSlackRun` →
          // `RunDO.appendTurn`, unchanged. The Slack `event_id` is the
          // idempotency token on either side, and the D1 `triage_decisions`
          // dedupe above it stays exactly where it was.
          wakeRun: async (input) => {
            await wakeRunOnActiveChassis(
              env,
              slackRunKey(input.channelId, input.threadTs),
              input.openingPrompt,
              { idempotencyKey: input.eventId },
            );
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
