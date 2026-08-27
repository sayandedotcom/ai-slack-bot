import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import { evalApi } from "../../src/api/eval";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";
import type { AiTell } from "../../src/eval/ai-tells";
import type { TriageScore } from "../../src/eval/triage-eval";
import type { Env } from "../../src/index";
import {
  cleanupEvalFixtures,
  DAY_MS,
  seedApproval,
  seedDecision,
  seedFourCellScenario,
  seedMessage,
} from "../helpers/eval-fixtures";

/**
 * The read-only eval API, driven through `SELF.fetch` with the Access verifier
 * faked at the port seam — the Phase 11/12 pattern from
 * `test/approval-api.test.ts`.
 *
 * WHY EVERY NUMERIC ASSERTION IS A DELTA. This pool has no `isolatedStorage`,
 * so `triage_decisions`, `messages` and `approvals` are shared with every other
 * suite in the run, and `GET /api/eval/triage` deliberately scores EVERYTHING
 * in the window rather than anything this file owns — it takes no channel or
 * tag parameter, because "how are we doing overall" is the question it answers.
 * Wiping those tables to get a clean count would break the neighbouring suites,
 * so instead each case reads the score, seeds its own tagged rows, reads it
 * again, and asserts the difference. Row-level claims are made by looking up
 * ids this file minted.
 *
 * THE PROPERTY THAT MAKES A DELTA SOUND is that nothing else writes to D1
 * between the two reads. `vitest.config.ts:5-8` records it: vitest-pool-workers
 * v0.21 "always runs one runtime per project", so test files run sequentially in
 * one isolate and no neighbouring suite can interleave a write. If that ever
 * stops being true, this file breaks — and so do the several existing suites
 * that `DELETE FROM` whole tables in a `beforeEach`.
 */

/* ------------------------------------------------------------- fixtures */

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      if (!jwt.includes("@"))
        throw new AccessJwtError("malformed", "not an email-shaped fake token");
      return { email: jwt };
    },
  };
}

const FIREFIGHTER = "ronit@zellify.app";
const VIEWER = "marcus@zellify.app";
const OUTSIDER = "nobody@example.com";

let tag: string;

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
  tag = `evl${crypto.randomUUID().slice(0, 8)}`;
});

afterEach(async () => {
  await cleanupEvalFixtures(tag);
  resetIdentityApiPorts();
});

async function req(path: string, token?: string): Promise<Response> {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return await SELF.fetch(`https://firefighter.example${path}`, { headers });
}

type TriageBody = {
  score: TriageScore;
  windowDays: number;
  unripeExcluded: number;
  truncated: boolean;
};
type ShadowPair = {
  approvalId: string;
  draft: string;
  why: string;
  createdAt: number;
  channelId: string;
  threadTs: string;
  tells: AiTell[];
  humanReply: { text: string; permalink: string | null; ts: string } | null;
};

async function triage(query = "", token = FIREFIGHTER): Promise<TriageBody> {
  const res = await req(`/api/eval/triage${query}`, token);
  expect(res.status).toBe(200);
  return (await res.json()) as TriageBody;
}

async function shadow(query = "", token = FIREFIGHTER): Promise<ShadowPair[]> {
  const res = await req(`/api/eval/shadow${query}`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { pairs: ShadowPair[] }).pairs;
}

/** What one seeded event did to the confusion matrix. */
function delta(before: TriageScore, after: TriageScore) {
  return {
    n: after.n - before.n,
    truePos: after.truePos - before.truePos,
    falsePos: after.falsePos - before.falsePos,
    falseNeg: after.falseNeg - before.falseNeg,
    trueNeg: after.trueNeg - before.trueNeg,
  };
}

/**
 * Seeds one woken decision plus one reply, and reports what it scored as.
 *
 * The trigger message is THREE DAYS old so the decision is ripe (the route only
 * scores decisions whose 24h answer window has elapsed), while the decision row
 * itself is stamped `now` so it sorts ahead of any neighbouring suite's
 * leftovers — the same split, for the same two reasons, as
 * `seedFourCellScenario`.
 */
async function wokenWithReply(input: {
  name: string;
  replyUserId: string;
  replyAfterMs: number;
  replyOutcome: "ingested" | "ingested_self";
}): Promise<ReturnType<typeof delta>> {
  const before = (await triage()).score;
  const now = Date.now();
  const triggeredAt = now - 3 * DAY_MS;
  const eventId = `ev:${tag}:${input.name}`;
  const threadTs = `${tag}.${input.name}`;
  await seedMessage({
    eventId,
    channelId: `C-${tag}`,
    ts: threadTs,
    threadTs,
    userId: `U-cust-${tag}`,
    text: "the webhook retries are still failing",
    permalink: `https://slack.example/${tag}/${input.name}`,
    receivedAt: triggeredAt,
  });
  await seedDecision({ eventId, wake: true, why: input.name, createdAt: now });
  await seedMessage({
    eventId: `ev:${tag}:${input.name}-reply`,
    channelId: `C-${tag}`,
    ts: `${tag}.${input.name}r`,
    threadTs,
    userId: input.replyUserId,
    text: "looking now",
    receivedAt: triggeredAt + input.replyAfterMs,
    outcome: input.replyOutcome,
  });
  const after = (await triage()).score;
  return delta(before, after);
}

/* ----------------------------------------------------------------- authz */

describe("eval API authorization", () => {
  for (const path of ["/api/eval/triage", "/api/eval/shadow"]) {
    it(`401s with no token on ${path}`, async () => {
      const res = await req(path);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe(
        "access_jwt_invalid"
      );
    });

    it(`401s a garbage token on ${path}`, async () => {
      expect((await req(path, "garbage")).status).toBe(401);
    });

    it(`403s an outsider with an otherwise-valid token on ${path}`, async () => {
      const res = await req(path, OUTSIDER);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        "not_a_firefighter"
      );
    });

    it(`200s for a viewer on ${path} — reads are for any of the seven`, async () => {
      expect((await req(path, VIEWER)).status).toBe(200);
    });
  }
});

/* -------------------------------------------------- GET /api/eval/triage */

describe("GET /api/eval/triage", () => {
  it("scores all four confusion cells", async () => {
    const before = (await triage()).score;
    const scenario = await seedFourCellScenario({ tag });
    const body = await triage();

    expect(delta(before, body.score)).toEqual({
      n: 4,
      truePos: 1,
      falsePos: 1,
      falseNeg: 1,
      trueNeg: 1,
    });

    // The disagreements carry the rows a human has to look at, and only those.
    const ids = body.score.disagreements.map((d) => d.eventId);
    expect(ids).toContain(scenario.falsePositive);
    expect(ids).toContain(scenario.falseNegative);
    expect(ids).not.toContain(scenario.truePositive);
    expect(ids).not.toContain(scenario.trueNegative);

    const fn = body.score.disagreements.find(
      (d) => d.eventId === scenario.falseNegative
    );
    expect(fn).toMatchObject({
      wake: false,
      humanEngaged: true,
      text: "is the fn deploy stuck?",
      permalink: `https://slack.example/${tag}/fn`,
    });
  });

  it("counts a reply 25 HOURS later as a false positive — the 24h window is real", async () => {
    expect(
      await wokenWithReply({
        name: "late",
        replyUserId: `U-eng-${tag}`,
        replyAfterMs: 25 * 60 * 60_000,
        replyOutcome: "ingested",
      })
    ).toEqual({ n: 1, truePos: 0, falsePos: 1, falseNeg: 0, trueNeg: 0 });
  });

  it("does not count a same-author follow-up as engagement", async () => {
    expect(
      await wokenWithReply({
        name: "self",
        replyUserId: `U-cust-${tag}`, // the person who triggered it, bumping their own thread
        replyAfterMs: 60 * 60_000,
        replyOutcome: "ingested",
      })
    ).toEqual({ n: 1, truePos: 0, falsePos: 1, falseNeg: 0, trueNeg: 0 });
  });

  /**
   * THE ASSERTION THIS WHOLE ROUTE EXISTS TO SURVIVE.
   *
   * Since 2026-08-14 the agent's own replies land in `messages` carrying the
   * ON-DUTY ENGINEER'S `user_id` — a different user id from the customer who
   * triggered the run, inside the 24h window, in the right thread. Every clause
   * of "a human engaged" is satisfied except `events_seen.outcome`. Drop that
   * one filter and precision climbs toward 1.0 as a direct function of the
   * agent replying more often, which is the one thing an eval must never
   * reward.
   *
   * Both halves are seeded so the ONLY difference between them is `outcome`.
   */
  it("does NOT count an ingested_self reply as engagement", async () => {
    expect(
      await wokenWithReply({
        name: "agentreply",
        replyUserId: `U-eng-${tag}`,
        replyAfterMs: 60 * 60_000,
        replyOutcome: "ingested_self",
      })
    ).toEqual({ n: 1, truePos: 0, falsePos: 1, falseNeg: 0, trueNeg: 0 });
  });

  it("counts the identical reply as engagement when it is ingested, not ingested_self", async () => {
    expect(
      await wokenWithReply({
        name: "humanreply",
        replyUserId: `U-eng-${tag}`,
        replyAfterMs: 60 * 60_000,
        replyOutcome: "ingested",
      })
    ).toEqual({ n: 1, truePos: 1, falsePos: 0, falseNeg: 0, trueNeg: 0 });
  });

  it("reports n with every rate, and null rather than 0 for an unmeasured rate", async () => {
    await seedFourCellScenario({ tag });
    const body = await triage();

    // With the four-cell scenario in the window both classes are non-empty, so
    // both rates are real numbers — no `if` guard, nothing that can pass by
    // being skipped.
    expect(body.score.n).toBeGreaterThanOrEqual(4);
    expect(body.score.truePos + body.score.falsePos).toBeGreaterThan(0);
    expect(body.score.truePos + body.score.falseNeg).toBeGreaterThan(0);
    expect(typeof body.score.precision).toBe("number");
    expect(typeof body.score.recall).toBe("number");
    expect(body.score.precision!).toBeGreaterThanOrEqual(0);
    expect(body.score.precision!).toBeLessThanOrEqual(1);
    expect(body.score.recall!).toBeGreaterThanOrEqual(0);
    expect(body.score.recall!).toBeLessThanOrEqual(1);

    // And the invariant itself, stated as an equivalence so it holds whatever
    // the shared database happens to contain: a rate is null EXACTLY when its
    // class is empty. Never 0 for "we never measured it".
    expect(body.score.precision === null).toBe(
      body.score.truePos + body.score.falsePos === 0
    );
    expect(body.score.recall === null).toBe(
      body.score.truePos + body.score.falseNeg === 0
    );
  });

  /**
   * RIPENESS. Engagement is looked for in `[received_at, received_at + 24h]`,
   * so a decision younger than 24h is being judged against a window that has
   * not finished: it would read FP or TN today and might become TP or FN
   * tomorrow, moving the headline number for reasons unrelated to the model.
   * Such decisions are excluded from the score and COUNTED in `unripeExcluded`,
   * so the shrunken denominator is visible rather than silent.
   */
  describe("ripeness", () => {
    /** One woken, unanswered decision whose trigger message is `ageMs` old. */
    async function seedAged(name: string, ageMs: number): Promise<void> {
      const now = Date.now();
      const eventId = `ev:${tag}:${name}`;
      await seedMessage({
        eventId,
        channelId: `C-${tag}`,
        ts: `${tag}.${name}`,
        threadTs: `${tag}.${name}`,
        userId: `U-cust-${tag}`,
        text: `age ${name}`,
        receivedAt: now - ageMs,
      });
      await seedDecision({ eventId, wake: true, why: name, createdAt: now });
    }

    it("excludes a decision whose 24h answer window has not elapsed", async () => {
      const before = await triage();
      await seedAged("fresh", 60 * 60_000); // one hour old
      const after = await triage();

      expect(delta(before.score, after.score).n).toBe(0);
      expect(after.unripeExcluded - before.unripeExcluded).toBe(1);
    });

    it("scores a decision at exactly the 24h cutoff, and one just inside it", async () => {
      const before = await triage();
      // Exactly 24h: the route evaluates `now` a few ms later than this test
      // does, so `received_at <= now - 24h` holds — the boundary is inclusive.
      await seedAged("exactly", DAY_MS);
      await seedAged("justripe", DAY_MS + 5 * 60_000);
      const after = await triage();

      // Both woken, neither answered: two more false positives, nothing excluded.
      expect(delta(before.score, after.score)).toEqual({
        n: 2,
        truePos: 0,
        falsePos: 2,
        falseNeg: 0,
        trueNeg: 0,
      });
      expect(after.unripeExcluded - before.unripeExcluded).toBe(0);
    });

    it("excludes one just outside the cutoff while scoring one just inside it", async () => {
      const before = await triage();
      await seedAged("inside", DAY_MS + 5 * 60_000);
      await seedAged("outside", DAY_MS - 5 * 60_000);
      const after = await triage();

      expect(delta(before.score, after.score).n).toBe(1);
      expect(after.unripeExcluded - before.unripeExcluded).toBe(1);
    });

    it("reports truncated:false for a window this size", async () => {
      await seedFourCellScenario({ tag });
      const body = await triage("?days=90");
      expect(body.truncated).toBe(false);
      expect(typeof body.unripeExcluded).toBe("number");
      expect(body.unripeExcluded).toBeGreaterThanOrEqual(0);
      // The bound exists and the flag reports it; well under it, `n` is the
      // window rather than the newest slice of it.
      expect(body.score.n).toBeLessThan(5000);
    });
  });

  it("clamps days to 1..90 at both ends rather than rejecting", async () => {
    expect((await triage("?days=0")).windowDays).toBe(1);
    expect((await triage("?days=-5")).windowDays).toBe(1);
    expect((await triage("?days=1000")).windowDays).toBe(90);
    expect((await triage("?days=45")).windowDays).toBe(45);
    expect((await triage("?days=nonsense")).windowDays).toBe(30);
    expect((await triage()).windowDays).toBe(30);
  });

  it("excludes decisions older than the window", async () => {
    const beforeNarrow = (await triage("?days=7")).score;
    const beforeWide = (await triage("?days=90")).score;

    const eventId = `ev:${tag}:ancient`;
    const longAgo = Date.now() - 40 * DAY_MS;
    await seedMessage({
      eventId,
      channelId: `C-${tag}`,
      ts: `${tag}.ancient`,
      threadTs: `${tag}.ancient`,
      userId: `U-cust-${tag}`,
      text: "ancient",
      receivedAt: longAgo,
    });
    await seedDecision({
      eventId,
      wake: true,
      why: "ancient",
      createdAt: longAgo,
    });

    // 40 days back: invisible at days=7, counted at days=90.
    expect(delta(beforeNarrow, (await triage("?days=7")).score).n).toBe(0);
    expect(delta(beforeWide, (await triage("?days=90")).score)).toEqual({
      n: 1,
      truePos: 0,
      falsePos: 1,
      falseNeg: 0,
      trueNeg: 0,
    });
  });
});

/* -------------------------------------------------- GET /api/eval/shadow */

describe("GET /api/eval/shadow", () => {
  const NOISY = "Great question! The deploy is stuck — we are on it; sorry.";
  const CLEAN = "The deploy is stuck. We are on it.";

  async function seedShadowCorpus(now = Date.now()) {
    const channelId = `C-${tag}`;
    const rows = [
      { name: "older", draft: CLEAN, at: now - 3 * 60_000 },
      { name: "newer", draft: NOISY, at: now - 1 * 60_000 },
    ] as const;
    for (const row of rows) {
      await seedApproval({
        id: `apr:${tag}:${row.name}`,
        runId: `run:${tag}:${row.name}`,
        runKey: `slack:C-${tag}:${tag}.${row.name}`,
        channelId,
        threadTs: `${tag}.${row.name}`,
        draft: row.draft,
        why: `why-${row.name}`,
        decision: "approved",
        delivery: "suppressed",
        createdAt: row.at,
      });
    }
    // A real human answered the OLDER thread.
    await seedMessage({
      eventId: `ev:${tag}:older-reply`,
      channelId,
      ts: `${tag}.olderr`,
      threadTs: `${tag}.older`,
      userId: `U-eng-${tag}`,
      text: "shipped the fix, retry now",
      permalink: `https://slack.example/${tag}/older-reply`,
      receivedAt: now - 2 * 60_000,
      outcome: "ingested",
    });
    // The NEWER thread has only the agent's own send in it.
    await seedMessage({
      eventId: `ev:${tag}:newer-self`,
      channelId,
      ts: `${tag}.newerself`,
      threadTs: `${tag}.newer`,
      userId: `U-eng-${tag}`,
      text: "we are on it",
      receivedAt: now - 30_000,
      outcome: "ingested_self",
    });
    return { channelId };
  }

  it("returns suppressed drafts newest first, with tells and the human reply", async () => {
    await seedShadowCorpus();
    const mine = (await shadow("?limit=50")).filter((p) =>
      p.approvalId.includes(tag)
    );

    expect(mine.map((p) => p.approvalId)).toEqual([
      `apr:${tag}:newer`,
      `apr:${tag}:older`,
    ]);
    expect(mine[0]!.createdAt).toBeGreaterThan(mine[1]!.createdAt);
    expect(mine[1]).toMatchObject({
      draft: CLEAN,
      why: "why-older",
      channelId: `C-${tag}`,
      threadTs: `${tag}.older`,
      tells: [],
    });
    expect(mine[1]!.humanReply).toEqual({
      text: "shipped the fix, retry now",
      permalink: `https://slack.example/${tag}/older-reply`,
      ts: `${tag}.olderr`,
    });
  });

  it("annotates each draft with the detector's tells", async () => {
    await seedShadowCorpus();
    const noisy = (await shadow("?limit=50")).find(
      (p) => p.approvalId === `apr:${tag}:newer`
    );
    expect(noisy!.tells).toEqual(
      expect.arrayContaining([
        "great_question",
        "exclamation",
        "em_dash",
        "semicolon",
      ])
    );
  });

  /**
   * The same invariant as the triage half, for the same reason: a shadow draft
   * compared against the agent's own send would be comparing the model to
   * itself. The newer thread holds exactly one later message and it is
   * `ingested_self`, so the honest answer is `null` — never an empty string.
   */
  it("reports humanReply null when the only later message is the agent's own", async () => {
    await seedShadowCorpus();
    const newer = (await shadow("?limit=50")).find(
      (p) => p.approvalId === `apr:${tag}:newer`
    );
    expect(newer!.humanReply).toBeNull();
  });

  it("never returns a pending or a sent approval", async () => {
    await seedShadowCorpus();
    const now = Date.now();
    await seedApproval({
      id: `apr:${tag}:pending`,
      runId: `run:${tag}:pending`,
      runKey: `slack:C-${tag}:${tag}.pending`,
      channelId: `C-${tag}`,
      threadTs: `${tag}.pending`,
      draft: CLEAN,
      why: "still waiting",
      decision: "pending",
      delivery: "none",
      createdAt: now,
    });
    await seedApproval({
      id: `apr:${tag}:sent`,
      runId: `run:${tag}:sent`,
      runKey: `slack:C-${tag}:${tag}.sent`,
      channelId: `C-${tag}`,
      threadTs: `${tag}.sent`,
      draft: CLEAN,
      why: "shipped",
      decision: "approved",
      delivery: "sent",
      createdAt: now,
    });

    const ids = (await shadow("?limit=50")).map((p) => p.approvalId);
    expect(ids).not.toContain(`apr:${tag}:pending`);
    expect(ids).not.toContain(`apr:${tag}:sent`);
    expect(ids).toContain(`apr:${tag}:newer`);
  });

  it("clamps limit to 1..50 at both ends rather than rejecting", async () => {
    const now = Date.now();
    for (let i = 0; i < 51; i++) {
      await seedApproval({
        id: `apr:${tag}:bulk${i}`,
        runId: `run:${tag}:bulk${i}`,
        runKey: `slack:C-${tag}:${tag}.bulk${i}`,
        channelId: `C-${tag}`,
        threadTs: `${tag}.bulk${i}`,
        draft: CLEAN,
        why: "bulk",
        decision: "approved",
        delivery: "suppressed",
        createdAt: now - i * 1_000,
      });
    }

    expect(await shadow("?limit=0")).toHaveLength(1);
    expect(await shadow("?limit=-3")).toHaveLength(1);
    expect(await shadow("?limit=999")).toHaveLength(50);
    expect(await shadow("?limit=nonsense")).toHaveLength(20);
    expect(await shadow()).toHaveLength(20);
  });
});

/* ------------------------------------------------------------- D1 only */

describe("the eval API is D1-only", () => {
  /**
   * ZERO DURABLE OBJECT INVOCATIONS, proved rather than asserted about.
   *
   * `SELF.fetch` runs against the pool's own env, which a test cannot swap — so
   * the strong form of this check drives the router directly with an env whose
   * `RUNS` binding is a booby trap: any property read on it is recorded and
   * throws. `getRunStub`/`idFromName`/`.get(...)` all begin with such a read
   * (`src/run/keys.ts` is the one place `idFromName` is called), so a route
   * that so much as constructs a stub fails here instead of quietly costing a
   * DO wake per scored decision.
   */
  it("touches env.RUNS zero times on both routes", async () => {
    const touched: string[] = [];
    const boobyTrap = new Proxy(
      {},
      {
        get(_target, prop) {
          touched.push(String(prop));
          throw new Error(
            `env.RUNS.${String(prop)} was read by a read-only eval route`
          );
        },
      }
    );
    const trappedEnv = { ...env, RUNS: boobyTrap } as unknown as Env;
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": FIREFIGHTER });

    const scenario = await seedFourCellScenario({ tag });
    await seedApproval({
      id: `apr:${tag}:do`,
      runId: `run:${tag}:do`,
      runKey: `slack:C-${tag}:${tag}.do`,
      channelId: `C-${tag}`,
      threadTs: `${tag}.do`,
      draft: "The deploy is stuck. We are on it.",
      why: "why",
      decision: "approved",
      delivery: "suppressed",
      createdAt: Date.now(),
    });

    const triageRes = await evalApi.request(
      "/eval/triage?days=90",
      { headers },
      trappedEnv
    );
    const shadowRes = await evalApi.request(
      "/eval/shadow?limit=50",
      { headers },
      trappedEnv
    );

    expect(triageRes.status).toBe(200);
    expect(shadowRes.status).toBe(200);

    // Both routes did REAL WORK with the booby trap in place — a 200 over an
    // empty result set would prove nothing about a code path never taken.
    const triageBody = (await triageRes.json()) as TriageBody;
    expect(triageBody.score.n).toBeGreaterThanOrEqual(4);
    expect(triageBody.score.disagreements.map((d) => d.eventId)).toContain(
      scenario.falsePositive
    );
    const pairs = ((await shadowRes.json()) as { pairs: ShadowPair[] }).pairs;
    expect(pairs.map((p) => p.approvalId)).toContain(`apr:${tag}:do`);

    expect(touched).toEqual([]);
  });
});
