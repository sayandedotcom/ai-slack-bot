import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../index";
import { AccessJwtError, makeAccessVerifier, type AccessIdentity, type AccessVerifier } from "../access/jwt";
import { isFirefighter, isTeamMember } from "../access/roster";
import {
  decideApproval,
  getApproval,
  listOpen,
  listUndeliveredResolutions,
  markResolutionDelivered,
} from "../approval/repository";
import { DecisionInputError, outboundText, type ApprovalRow, type DecisionInput } from "../approval/contracts";

/**
 * One human decision on one proposed customer Slack reply, over HTTP. This is
 * the ONLY mutating surface for approval state (invariant 6/constraint 1): the
 * DO writes `withdrawn` and delivery states through its own RPCs, but a human
 * writes `approved` / `edited` / `rejected` through `PATCH /api/approvals/:id`
 * alone, and this file is the whole of that path.
 *
 * See `shared-contracts.md`'s "HTTP API" table for the route/who/behavior grid
 * this file implements verbatim, and its "Authorization seam" for the verifier
 * and roster this composes rather than reimplements.
 */

/**
 * The seam Task 5's Durable Object RPC lands behind. Defined HERE, not in
 * `src/run/do.ts`, specifically so this task could ship against a fake while
 * Task 5 was still in flight. Its production implementation —
 * `makeRunDoResolutionNotifier`, which calls the owning RunDO stub's
 * `resolveApproval` — lives in `src/approval/notifier.ts` and is composed in
 * `resolvePorts` below, exactly like the verifier.
 */
export interface ResolutionNotifier {
  notify(input: {
    runId: string;
    approvalId: string;
    decision: "approved" | "edited" | "rejected";
    outboundText: string | null;
    rejectReason: string | null;
    decidedBy: string;
  }): Promise<{ applied: boolean }>;
}

export const approvalsApi = new Hono<{ Bindings: Env }>();

/* ------------------------------------------------------------- ports ---- */

type ApprovalApiPorts = {
  verifier: AccessVerifier;
  notifier: ResolutionNotifier;
};

/**
 * Module-scope port registry, the same shape `src/agent/driver.ts` uses for
 * `RunPorts` (`installRunPorts`/`resolveRunPorts`): a plain object a test can
 * override before `SELF.fetch` ever runs, and production fills the gap lazily
 * on first use because only a REQUEST has `env`, not module load.
 *
 * Unlike the run layer there is no per-key scoping here — an approval route
 * has no natural equivalent of a run key to scope a fake by, and every test
 * in this file resets the registry itself before each case, exactly like the
 * unkeyed half of `installRunPorts`.
 */
let GLOBAL_PORTS: Partial<ApprovalApiPorts> = {};

/** Test seam: override either port before a request reaches `resolvePorts`. */
export function installApprovalApiPorts(ports: Partial<ApprovalApiPorts>): void {
  GLOBAL_PORTS = { ...GLOBAL_PORTS, ...ports };
}

/** Test seam: forget everything installed. */
export function resetApprovalApiPorts(): void {
  GLOBAL_PORTS = {};
}

/**
 * Fills in the production ports IF NOTHING IS THERE YET, and returns whatever
 * the registry now holds. Both are still typed optional at every call site
 * below: a request that arrives before this ran would otherwise be a crash on
 * the path that carries a human's decision, and `undefined` there means
 * `resolutionDelivered: false` and a sweeper repair, which is precisely
 * invariant 9's designed behaviour.
 *
 * This is the property invariant 11 needs stated as code rather than prose:
 * there is no flag, no env check, and no code path that can produce an
 * `AccessVerifier` other than `makeAccessVerifier` itself. A test that wants a
 * fake MUST call `installApprovalApiPorts` before the request; anything else
 * gets the real thing, built from the same `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD`
 * vars Task 2 defined.
 */
function resolvePorts(env: Env): Partial<ApprovalApiPorts> & { verifier: AccessVerifier } {
  if (GLOBAL_PORTS.verifier === undefined) {
    GLOBAL_PORTS = {
      ...GLOBAL_PORTS,
      verifier: makeAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_APP_AUD }),
    };
  }
  // NO PRODUCTION NOTIFIER. The agent layer was removed on 2026-08-23 to be
  // rebuilt on the Agents SDK / Project Think / Code Mode, so there is no run
  // session to deliver a decision TO.
  //
  // Nothing else about this route changes, and that is the point: the Access
  // JWT, the roster check and the D1 CAS all still run, so a human's decision
  // is still committed exactly once and is never lost. With no notifier the
  // handler reports `resolutionDelivered: false` and the one-minute sweep keeps
  // re-driving the row — which is invariant 9's designed behaviour for an
  // unreachable run, not a new failure mode. Install one here when the new
  // chassis lands.
  return GLOBAL_PORTS as Partial<ApprovalApiPorts> & { verifier: AccessVerifier };
}

/* ------------------------------------------------------------ authz ---- */

function fail(code: string, message: string) {
  // No stack traces, no token contents, no JWKS material — errors cross to the
  // browser (constraint 8 / invariant 12).
  return { code, message };
}

/**
 * Validates the Access JWT and returns the identity it proves, or the
 * `Response` to send back verbatim. Every route below starts here — there is
 * no route in this file that reads `c.req.header` for identity itself.
 *
 * This file does NOT rate-limit or circuit-break failed verifications. An
 * earlier revision added an unkeyed, pre-identity attempt cap here and a
 * review caught it doing the opposite of its intent: free-to-produce failures
 * (`AccessJwtError("missing"...)` for a header-less request costs zero JWKS
 * calls — see `src/access/jwt.ts`) would trip it long before any real
 * amplification occurred, and once tripped it denied EVERY caller, including
 * a fire-fighter with a genuinely valid token, because the check ran before
 * `isFirefighter`/`isTeamMember` and was not scoped by identity, IP, or
 * `kid`. The actual JWKS key-miss amplification this was meant to guard
 * against is bounded at its real source instead: `resolveKey`'s short-TTL
 * negative cache in `src/access/jwt.ts`, which throttles the expensive
 * operation (the JWKS fetch) directly rather than refusing traffic on this
 * route as a proxy for it.
 */
async function requireIdentity(c: Context<{ Bindings: Env }>): Promise<AccessIdentity | Response> {
  const { verifier } = resolvePorts(c.env);
  const jwt = c.req.header("Cf-Access-Jwt-Assertion") ?? "";
  try {
    return await verifier.verify(jwt);
  } catch (err) {
    const reason = err instanceof AccessJwtError ? err.code : "invalid";
    return c.json(fail("access_jwt_invalid", `token failed verification: ${reason}`), 401);
  }
}

/* -------------------------------------------------------- public shapes */

/** `GET /api/approvals?state=open`'s row shape — the queue card, nothing more. */
function publicApprovalSummary(row: ApprovalRow) {
  return {
    id: row.id,
    runId: row.runId,
    draft: row.draft,
    why: row.why,
    channelId: row.channelId,
    threadTs: row.threadTs,
    createdAt: row.createdAt,
  };
}

/**
 * `GET /api/approvals/:id` and the `PATCH` response: the queue card plus
 * decision/delivery state. `decidedBy` is a validated email, not a secret —
 * it is PII the dashboard legitimately needs (constraint 8) — so it crosses
 * here same as every other column on the row.
 */
function publicApprovalCard(row: ApprovalRow) {
  return {
    ...publicApprovalSummary(row),
    updatedAt: row.updatedAt,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    editedText: row.editedText,
    rejectReason: row.rejectReason,
    delivery: row.delivery,
  };
}

/* -------------------------------------------------------------- reads --- */

/**
 * The dashboard's open queue. D1 ONLY (invariant 7 / constraint 2) — this
 * route must never instantiate or call a Durable Object, or a list of N open
 * approvals costs N wakes for no reason a list view needs.
 */
approvalsApi.get("/approvals", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;
  if (!isTeamMember(identity.email)) {
    return c.json(fail("not_a_firefighter", "not a recognized team member"), 403);
  }

  const stateParam = c.req.query("state");
  if (stateParam !== undefined && stateParam !== "open") {
    return c.json(fail("invalid_state", "state must be 'open'"), 400);
  }

  const rows = await listOpen(c.env.DB);
  return c.json({ approvals: rows.map(publicApprovalSummary) });
});

/** One card. Same D1-only reasoning as the list route above. */
approvalsApi.get("/approvals/:id", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;
  if (!isTeamMember(identity.email)) {
    return c.json(fail("not_a_firefighter", "not a recognized team member"), 403);
  }

  const row = await getApproval(c.env.DB, c.req.param("id"));
  if (!row) return c.json(fail("unknown_approval", "no such approval"), 404);

  return c.json({ approval: publicApprovalCard(row) });
});

/* ---------------------------------------------------------- decisions --- */

/**
 * Parses the PATCH body into a `DecisionInput`, or `null` for any shape this
 * route refuses: an unknown/missing `action`, or an `edit`/`reject` whose
 * `text`/`reason` is not even a string. A present-but-blank string is a
 * DIFFERENT failure mode — that one reaches `decideApproval`, which throws
 * `DecisionInputError` after validating against the D1 row's shape — but both
 * land on the same `422 invalid_action` response.
 */
function parseDecisionInput(body: unknown): DecisionInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  if (record.action === "approve") return { action: "approve" };
  if (record.action === "edit") {
    return typeof record.text === "string" ? { action: "edit", text: record.text } : null;
  }
  if (record.action === "reject") {
    return typeof record.reason === "string" ? { action: "reject", reason: record.reason } : null;
  }
  return null;
}

/**
 * The one writer surface for a human decision. Fire-fighters only (constraint
 * 3 / invariant 11): a viewer gets `403 not_a_firefighter` before this
 * function ever parses the body or touches D1, which is what keeps the row
 * untouched on that path — there is no D1 call earlier than this check that
 * could leave a trace.
 */
approvalsApi.patch("/approvals/:id", async (c) => {
  const identity = await requireIdentity(c);
  if (identity instanceof Response) return identity;
  if (!isFirefighter(identity.email)) {
    return c.json(fail("not_a_firefighter", "decisions are fire-fighters only"), 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail("invalid_action", "body must be JSON"), 422);
  }

  const input = parseDecisionInput(body);
  if (!input) {
    return c.json(fail("invalid_action", "unknown action, or edit/reject missing its field"), 422);
  }

  let result;
  try {
    result = await decideApproval(c.env.DB, c.req.param("id"), input, identity.email, Date.now());
  } catch (err) {
    if (err instanceof DecisionInputError) {
      return c.json(fail("invalid_action", err.code), 422);
    }
    throw err;
  }

  if (result.result === "not_found") {
    return c.json(fail("unknown_approval", "no such approval"), 404);
  }
  if (result.result === "already_decided") {
    // The CAS's loser (invariant 8): carries the WINNING decision, so the
    // dashboard can show what actually happened instead of a bare conflict.
    return c.json({ ...fail("already_decided", "already decided"), decision: result.row.decision }, 409);
  }

  const row = result.row;
  // Known from `input.action`, not re-derived from `row.decision`: the
  // repository's own mapping (approve->approved, edit->edited, reject->rejected)
  // is the single source of truth this mirrors, and using the input keeps this
  // branch a plain literal union instead of re-narrowing `ApprovalRow.decision`
  // (whose type also allows `pending`/`withdrawn`, which cannot be true here).
  const decision: "approved" | "edited" | "rejected" =
    input.action === "approve" ? "approved" : input.action === "edit" ? "edited" : "rejected";

  /**
   * INVARIANT 9, the subtlest rule in this task: the D1 decision above already
   * committed. Nothing from here on may roll it back. `notify` reaching a dead
   * or unreachable DO — or a `notifier` port that is somehow absent — is
   * caught exactly like an application-level `{applied:false}` refusal from
   * the DO itself: either way this handler still
   * returns 200 with the row's real decision and `resolutionDelivered:false`.
   *
   * This LOOKS like a bug to a reviewer who has not read invariant 9 — a
   * "successful" PATCH whose delivery silently failed — but the alternative
   * (failing the PATCH, or worse, trying to undo the CAS) is the actual bug:
   * a human's click must never be lost because the DO happened to be
   * unreachable at that exact millisecond. The one-minute sweeper below
   * (`sweepUndeliveredApprovals`) is the repair path for exactly this row,
   * driven by `resolution_delivered_at IS NULL`.
   */
  let delivered = false;
  try {
    const { notifier } = resolvePorts(c.env);
    const outcome = await notifier?.notify({
      runId: row.runId,
      approvalId: row.id,
      decision,
      outboundText: decision === "rejected" ? null : outboundText(row),
      rejectReason: row.rejectReason,
      decidedBy: identity.email,
    });
    delivered = outcome?.applied ?? false;
  } catch {
    delivered = false;
  }
  if (delivered) {
    await markResolutionDelivered(c.env.DB, row.id, Date.now());
  } else {
    // Swallowed, never silent. The decision stands either way (invariant 9),
    // but a decision that did not reach its run is the one thing an operator
    // needs to know is now riding on the sweeper — and until this line existed,
    // the only trace of it was a `resolutionDelivered:false` in a response
    // nobody keeps. Ids only: no draft, no edited text, no decider.
    console.warn("approval notify did not apply; the sweeper will re-drive it", {
      approvalId: row.id,
      runId: row.runId,
    });
  }

  // `row` is the SELECT from `decideApproval`'s own batch — taken BEFORE
  // `notify` ran. By the time a successful notify returns, the owning DO has
  // already moved `delivery` past `none` (`blocked` under Phase 11's
  // identity-refusing sender), and a response built from `row` would report a
  // state the DO no longer holds. Re-reading after notify settles is what
  // makes the body match what actually happened; it must stay AFTER the
  // notify branch above, never before, or it would just re-read the same
  // pre-delivery snapshot. Falls back to `row` — not a 404 — if the re-read
  // somehow returns nothing: the decision already committed (invariant 9),
  // and a human's click is not withheld because a follow-up read raced
  // something. This does not touch the notify-failure path above: a dead or
  // unreachable DO still returns 200 with `resolutionDelivered:false` and the
  // decided row exactly as `decideApproval` left it, delivery included.
  const fresh = await getApproval(c.env.DB, row.id);
  return c.json({ approval: publicApprovalCard(fresh ?? row), resolutionDelivered: delivered });
});

/* ------------------------------------------------------------- sweeper --- */

/** One page per minute, matching `listUndeliveredResolutions`'s own bound. */
export const APPROVAL_SWEEP_PAGE_SIZE = 10;

export type ApprovalSweepResult = {
  due: number;
  delivered: number;
  failed: number;
};

/**
 * The repair path for invariant 9. Extends the existing one-minute
 * `scheduled()` sweeper (see `src/memory/sweeper.ts` for the sibling this
 * mirrors): every decided row whose resolution never reached the DO —
 * `resolution_delivered_at IS NULL` — gets one more `notify` attempt this
 * minute. A row whose notify already landed via the DO's own idempotent
 * handling of a redelivered resolution simply gets re-marked delivered; a row
 * still undeliverable stays due for the next sweep.
 *
 * Bounded to one page (`APPROVAL_SWEEP_PAGE_SIZE`) for the same reason the
 * memory sweeper is: this runs every minute forever, and a sweep that tried to
 * drain an unbounded backlog would eventually take longer than its own
 * interval.
 */
export async function sweepUndeliveredApprovals(
  env: Env,
  now: number = Date.now(),
): Promise<ApprovalSweepResult> {
  const { notifier } = resolvePorts(env);
  const due = await listUndeliveredResolutions(env.DB, APPROVAL_SWEEP_PAGE_SIZE);
  let delivered = 0;
  let failed = 0;

  for (const row of due) {
    // `listUndeliveredResolutions` filters to `decision IN ('approved',
    // 'edited', 'rejected')`, so this cast is exhaustive by construction — a
    // `pending` or `withdrawn` row cannot appear here.
    const decision = row.decision as "approved" | "edited" | "rejected";
    try {
      const outcome = await notifier?.notify({
        runId: row.runId,
        approvalId: row.id,
        decision,
        outboundText: decision === "rejected" ? null : outboundText(row),
        rejectReason: row.rejectReason,
        decidedBy: row.decidedBy ?? "",
      });
      if (outcome?.applied) {
        await markResolutionDelivered(env.DB, row.id, now);
        delivered += 1;
      } else {
        failed += 1;
      }
    } catch {
      // One unreachable row must not abandon the rest of the page — same
      // discipline as `sweepMemoryOutbox`.
      failed += 1;
    }
  }

  if (failed > 0 || due.length >= APPROVAL_SWEEP_PAGE_SIZE) {
    console.warn("approval sweep", { due: due.length, delivered, failed });
  }

  return { due: due.length, delivered, failed };
}
