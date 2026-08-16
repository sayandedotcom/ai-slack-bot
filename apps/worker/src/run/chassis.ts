/**
 * The one place `RUN_CHASSIS` is read, and the one way a run is woken.
 *
 * Two session implementations are live at once during the strangler window
 * (spec D1): the legacy `RunDO` + `streamText` loop, and `RunAgent extends
 * Think<Env>`. Every wake goes through `wakeRun()` so the choice between them
 * is a single branch in a single file rather than a condition sprinkled across
 * the triage consumer, the queue handler and the API routes.
 *
 * The idempotency story differs by chassis and both halves are kept:
 *
 *  - upstream, D1 still dedupes the wake itself — `triage_decisions` is written
 *    before the wake and re-read on every retry, so a replayed queue message
 *    never re-asks the model. That belt is NOT removed by this façade;
 *  - downstream, the legacy chassis dedupes on the turn id (`triage:{event_id}`
 *    inside `RunDO.appendTurn`) and the Think chassis dedupes on the submission
 *    `idempotencyKey`. Same guarantee, two mechanisms, and the caller sees one.
 */

import { getAgentByName } from "agents";
import type { RunTurnSubmit, SubmitMessagesResult } from "@cloudflare/think";
import type { Env } from "../index";
import type { RunAgent } from "./agent";
import { createChatRun, ensureSlackRunRowUnderPolicy, wakeSlackRun } from "./coordinator";
import { assertRunKey, chatRunKey, runOriginOf } from "./keys";
import { createOrGetRun, getRunByKey, type RunRecord } from "./repository";

/** The two session implementations. Nothing else is a legal `RUN_CHASSIS`. */
export type RunChassis = "think" | "legacy";

export class RunChassisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunChassisError";
  }
}

/**
 * Resolve the configured chassis, refusing anything that is not one of the two.
 *
 * `Env["RUN_CHASSIS"]` is deliberately NOT narrowed to the bare literal union
 * (see the comment on the field in `src/index.ts`): `Cloudflare.Env` types it
 * `string`, and narrowing it there would make dozens of existing tests' plain
 * pool env illegal for no safety gained, since the value arrives from a config
 * file at runtime regardless. This function is the compensating control — the
 * single read site, and it fails closed.
 *
 * "Fails closed" here means THROWING, not falling back to legacy. A typo
 * (`"Think"`, `"thnk"`) that silently resolved to the other chassis would run
 * an incident on a session implementation the operator did not choose, with no
 * error anywhere — the exact silent-wrong-answer this whole migration is
 * trying not to ship.
 *
 * The message names the variable, never its value (invariant 39's rule applied
 * uniformly: no configured value is ever echoed, secret-shaped or not).
 */
export function resolveChassis(env: Env): RunChassis {
  const configured = env.RUN_CHASSIS;
  if (configured === undefined || configured === "legacy") return "legacy";
  if (configured === "think") return "think";
  throw new RunChassisError(
    'RUN_CHASSIS is set to an unrecognised value; expected "think" or "legacy"',
  );
}

/**
 * The one `runTurn` overload this file calls, restated.
 *
 * MEASURED TRAP: `Think.runTurn` is overloaded three ways (`wait` | `submit` |
 * `stream`), and a Durable Object RPC stub maps an overloaded method to its
 * LAST overload only — `runTurn(options: RunTurnStream): Promise<void>`. So the
 * correct submit call through the stub is a compile error (`Type '"submit"' is
 * not assignable to type '"stream"'`, then `Property 'accepted' does not exist
 * on type 'void'`) even though it is exactly right at runtime. Narrowing the
 * stub to this shape — built from the package's OWN exported types, not `any` —
 * is what recovers the signature the runtime actually honours.
 */
type SubmitOnlyAgent = {
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
};

/**
 * Wake the run that owns `key` with `input`, on whichever chassis is configured.
 *
 * `opts.idempotencyKey` is the caller's natural dedupe token — for a Slack wake
 * that is the `event_id`, which is also what the legacy turn id is built from.
 * A repeat of the same token must never start a second turn.
 *
 * Returns `accepted: false` when the wake was a repeat that the session already
 * holds; `accepted: true` when this call is the one that admitted the work.
 */
export async function wakeRun(
  env: Env,
  key: string,
  input: string,
  opts: { idempotencyKey: string },
): Promise<{ accepted: boolean }> {
  // Re-validated before it names an object, exactly as `runStubForKey` does —
  // a corrupted `runs.key` must not be able to conjure an anonymous agent.
  const runKey = assertRunKey(key);

  if (resolveChassis(env) === "think") {
    // THE D1 ROW AND THE RATCHET COME FIRST, BEFORE ANY TURN EXISTS.
    //
    // This is the same ordering the legacy branch gets for free by going
    // through `wakeSlackRun`, and it is the enforcement point for invariant 37:
    // by the time a generation exists, the `runs` row the shared write guard
    // re-reads already says shadow, so every `external_write` the run attempts
    // is denied. Doing it after the submit would leave a window in which a run
    // on an `observe` channel has work scheduled and no row saying so.
    //
    // It is also what makes the run ADDRESSABLE at all on this chassis: the
    // public `runs.id` is a separate UUID resolved through D1 (invariant 10),
    // and `/agents/*`, the approval sweep and the run-index projection all
    // start from that row. Without it a Think Slack run is invisible to every
    // one of them.
    //
    // FAIL CLOSED: if the policy read or the row write throws, this throws, and
    // the wake never happens. There is deliberately no catch that proceeds with
    // a default — an unresolvable policy must not become a postable run.
    await ensureRunRowUnderPolicy(env, runKey);

    const stub = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, runKey);
    const agent = stub as unknown as SubmitOnlyAgent;
    // `submit` is durable and idempotent: the submission row is keyed on
    // `idempotencyKey`, so a repeated Slack `event_id` returns
    // `accepted: false` instead of starting a second turn (verified fact 10).
    // It is also the only legal mode from inside a turn — `wait`/`stream`
    // cannot nest — which matters because a wake can arrive while the run is
    // mid-answer.
    const out = await agent.runTurn({
      mode: "submit",
      input,
      idempotencyKey: opts.idempotencyKey,
    });
    return { accepted: out.accepted };
  }

  return legacyWake(env, runKey, input, opts);
}

/**
 * The pre-existing path, unchanged: `wakeSlackRun` re-resolves the channel
 * policy, applies the shadow ratchet, and appends `triage:{event_id}` through
 * `RunDO.appendTurn`. Reused rather than re-implemented — the operation that
 * creates a run and the operation that continues it must stay the same one.
 *
 * `wakeSlackRun` answers with the `RunRecord`, not with the append result, so
 * there is no novelty signal to forward; a completed legacy wake reports
 * `accepted: true`. That is not a regression: the legacy chassis's own dedupe
 * is the turn id inside the DO, and the D1 `triage_decisions` check upstream is
 * still the thing that stops a replayed queue message. Nothing branches on the
 * return value on this path today.
 */
async function legacyWake(
  env: Env,
  runKey: string,
  input: string,
  opts: { idempotencyKey: string },
): Promise<{ accepted: boolean }> {
  if (runOriginOf(runKey) !== "slack") {
    // Chat runs are created and continued by `src/api/runs.ts` against the DO
    // directly; they have never gone through a wake. Refusing by name beats
    // inventing a second chat-creation path here that no caller exercises.
    throw new RunChassisError("the legacy chassis wakes slack runs only");
  }

  const { channelId, threadTs } = slackPartsOf(runKey);
  await wakeSlackRun(env, {
    eventId: opts.idempotencyKey,
    channelId,
    threadTs,
    openingPrompt: input,
  });
  return { accepted: true };
}

/**
 * Split an ALREADY-VALIDATED `slack:{channel}:{thread_ts}` key back into its
 * two parts. Safe only after `assertRunKey`, which is why it takes the key by
 * that name and is private to this file.
 */
function slackPartsOf(runKey: string): { channelId: string; threadTs: string } {
  const rest = runKey.slice("slack:".length);
  const separator = rest.indexOf(":");
  return { channelId: rest.slice(0, separator), threadTs: rest.slice(separator + 1) };
}

/**
 * Make sure the D1 `runs` row for `runKey` exists and carries the right shadow
 * flag, whatever the run's origin.
 *
 * Slack runs go through `ensureSlackRunRowUnderPolicy` — the coordinator's own
 * helper, not a copy of its rules — so the channel policy is re-read on every
 * wake and the one-way ratchet applied. Chat runs have no channel and therefore
 * no policy to read: `createOrGetRun` is `createOrGetRunUnderPolicy` with the
 * ratchet bound off, which is exactly what the legacy chat path does.
 *
 * Idempotent, so a redelivered wake re-reads the policy (the point) and writes
 * no row (`INSERT OR IGNORE`).
 */
async function ensureRunRowUnderPolicy(env: Env, runKey: string): Promise<RunRecord> {
  if (runOriginOf(runKey) === "slack") {
    const { channelId, threadTs } = slackPartsOf(runKey);
    return ensureSlackRunRowUnderPolicy(env, {
      key: runKey,
      origin: "slack",
      channelId,
      threadTs,
    });
  }
  return createOrGetRun(env.DB, {
    key: runKey,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
}

/**
 * Start a dashboard-initiated chat run on whichever chassis is configured, and
 * deliver its opening message.
 *
 * `POST /api/runs` used to call `createChatRun` — i.e. `RunDO` — unconditionally.
 * Under `RUN_CHASSIS=think` that put the run's first message into a session
 * nothing was listening to: the row and the id came back, the dashboard opened
 * the `RunAgent` socket the id resolves to, and the opening turn sat in the
 * other object forever, unanswered and with no error anywhere. A silent wrong
 * answer, which is the one failure mode this façade exists to prevent — so the
 * route goes through here now, and neither branch is reachable by accident.
 *
 * The idempotency token is `steer:{requestId}`, the SAME string the legacy path
 * uses as its turn id and the same one `POST /api/runs/:id/turns` and the run
 * socket use. A client that retries a create it never saw the response to
 * re-delivers the same token, and the Think submission row refuses it exactly
 * as `RunDO.appendTurn` refuses the duplicate turn id.
 *
 * Returns the row as it stands AFTER the opening turn was admitted, for the
 * same reason `createChatRun` re-reads it: this is the one moment the client's
 * only view of the run is the row we are about to hand back.
 */
export async function createRunFromChat(
  env: Env,
  options: { firstMessage?: string; requestId?: string } = {},
): Promise<RunRecord> {
  if (resolveChassis(env) === "legacy") {
    const { run } = await createChatRun(env, options);
    return run;
  }

  // Both uuids are still minted here, and they are still different values:
  // the public `runs.id` comes from the insert, the `chat:{uuid}` key is this
  // one, and the key never leaves the Worker (invariant 10).
  const key = chatRunKey(crypto.randomUUID());
  const run = await ensureRunRowUnderPolicy(env, key);

  const first = options.firstMessage?.trim();
  if (!first) return run;

  await wakeRun(env, key, first, { idempotencyKey: `steer:${options.requestId ?? run.id}` });

  // `RunAgent` owns its own status; the D1 row is a projection of it. Re-read
  // so a client that renders straight from this response sees whatever the
  // wake committed rather than the pre-wake snapshot.
  return (await getRunByKey(env.DB, key)) ?? run;
}
