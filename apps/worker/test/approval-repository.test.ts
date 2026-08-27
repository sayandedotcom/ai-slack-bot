import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DecisionInputError,
  type ApprovalRow,
} from "../src/approval/contracts";
import {
  claimNudge,
  decideApproval,
  getApproval,
  insertApproval,
  listOpen,
  listUndeliveredResolutions,
  markResolutionDelivered,
  recordNudgeMessage,
  setDelivery,
  withdrawApproval,
  type NewApprovalCard,
} from "../src/approval/repository";

/**
 * Real D1 through the workerd vitest pool, no `isolatedStorage` (see
 * `vitest.config.ts` and `phase-08-notes.md`). D1 is shared across every
 * suite in the pool, so — same discipline as `run-repository.test.ts` — every
 * case here mints its own run id and never assumes the `approvals` or `runs`
 * table is empty. `approvals.run_id REFERENCES runs(id)`, so each case seeds
 * one real, minimal `runs` row of its own (`chat` origin needs no
 * channel/thread; the approval's own `channelId`/`threadTs` are independent
 * columns on `approvals`, snapshotted for display).
 */

// D1 is shared across every case in this file (see run-repository.test.ts's
// identical note), and unlike `runs` — where every test mints a fresh id and
// so never collides — `listOpen` and `listUndeliveredResolutions` assert
// exact membership, which only holds if the table starts each case empty.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
});

async function seedRun(): Promise<string> {
  const runId = `run_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'chat', NULL, NULL, 'idle', 0, ?, ?)`
  )
    .bind(runId, `chat:${crypto.randomUUID()}`, Date.now(), Date.now())
    .run();
  return runId;
}

function card(
  runId: string,
  overrides: Partial<NewApprovalCard> = {}
): NewApprovalCard {
  return {
    id: `apr:${crypto.randomUUID()}`,
    runId,
    generationId: `gen:${crypto.randomUUID()}`,
    draft: "We can refund the last invoice.",
    why: "customer asked for a refund, this is committal",
    channelId: "C1",
    threadTs: "1720000000.123456",
    shadow: false,
    now: Date.now(),
    ...overrides,
  };
}

describe("insertApproval", () => {
  it("creates a row and getApproval round-trips it", async () => {
    const runId = await seedRun();
    const c = card(runId);

    expect(await insertApproval(env.DB, c)).toBe("created");

    const row = await getApproval(env.DB, c.id);
    expect(row).toMatchObject({
      id: c.id,
      runId,
      generationId: c.generationId,
      draft: c.draft,
      why: c.why,
      channelId: c.channelId,
      threadTs: c.threadTs,
      shadow: false,
      decision: "pending",
      decidedBy: null,
      decidedAt: null,
      editedText: null,
      rejectReason: null,
      delivery: "none",
    });
    expect(typeof row?.createdAt).toBe("number");
    expect(typeof row?.updatedAt).toBe("number");
  });

  it("returns null from getApproval for an unknown id", async () => {
    expect(await getApproval(env.DB, `apr:${crypto.randomUUID()}`)).toBeNull();
  });

  it("carries the shadow flag through", async () => {
    const runId = await seedRun();
    const c = card(runId, { shadow: true });
    await insertApproval(env.DB, c);
    expect((await getApproval(env.DB, c.id))?.shadow).toBe(true);
  });

  describe("one unsettled approval per run — partial unique index", () => {
    it("refuses a second insert while the first is pending", async () => {
      const runId = await seedRun();
      const first = card(runId);
      const second = card(runId);

      expect(await insertApproval(env.DB, first)).toBe("created");
      expect(await insertApproval(env.DB, second)).toBe("duplicate_open");

      // The refused candidate must not exist as a row at all.
      expect(await getApproval(env.DB, second.id)).toBeNull();
    });

    it("still refuses a second insert once the first is decided but undelivered", async () => {
      const runId = await seedRun();
      const first = card(runId);
      await insertApproval(env.DB, first);

      const decided = await decideApproval(
        env.DB,
        first.id,
        { action: "approve" },
        "ronit@zellify.app",
        100
      );
      expect(decided.result).toBe("decided");
      if (decided.result !== "decided") throw new Error("unreachable");
      expect(decided.row.decision).toBe("approved");
      expect(decided.row.delivery).toBe("none"); // decideApproval never touches delivery

      const second = card(runId);
      expect(await insertApproval(env.DB, second)).toBe("duplicate_open");
    });

    it("frees the slot once delivery reaches a terminal state (blocked)", async () => {
      const runId = await seedRun();
      const first = card(runId);
      await insertApproval(env.DB, first);
      await decideApproval(
        env.DB,
        first.id,
        { action: "approve" },
        "ronit@zellify.app",
        100
      );

      expect(
        await setDelivery(
          env.DB,
          first.id,
          ["none"],
          "blocked",
          "identity_unavailable",
          200
        )
      ).toBe(true);

      const second = card(runId);
      expect(await insertApproval(env.DB, second)).toBe("created");
    });

    it("does not free the slot for a different, unrelated run", async () => {
      const runA = await seedRun();
      const runB = await seedRun();
      await insertApproval(env.DB, card(runA));

      // A pending approval on a DIFFERENT run must never be blocked by runA's.
      expect(await insertApproval(env.DB, card(runB))).toBe("created");
    });
  });
});

describe("decideApproval — exactly-once CAS", () => {
  it("two concurrent decisions on the same row yield exactly one winner", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const [a, b] = await Promise.all([
      decideApproval(
        env.DB,
        c.id,
        { action: "approve" },
        "ronit@zellify.app",
        100
      ),
      decideApproval(
        env.DB,
        c.id,
        { action: "reject", reason: "not accurate" },
        "luka@zellify.app",
        101
      ),
    ]);

    const results = [a.result, b.result].sort();
    expect(results).toEqual(["already_decided", "decided"]);

    const winner = a.result === "decided" ? a : b;
    const loser = a.result === "decided" ? b : a;
    if (winner.result !== "decided" || loser.result !== "already_decided") {
      throw new Error("unreachable");
    }

    // The loser carries the WINNER's row back, not its own attempted decision.
    expect(loser.row).toEqual(winner.row);
    expect(["approved", "rejected"]).toContain(winner.row.decision);

    const finalRow = await getApproval(env.DB, c.id);
    expect(finalRow).toEqual(winner.row);
  });

  it("approve records decidedBy/decidedAt and no reject/edit fields", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const result = await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      500
    );
    expect(result).toEqual({
      result: "decided",
      row: expect.objectContaining({
        decision: "approved",
        decidedBy: "ronit@zellify.app",
        decidedAt: 500,
        editedText: null,
        rejectReason: null,
      }),
    });
  });

  it("edit records the edited text", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const result = await decideApproval(
      env.DB,
      c.id,
      { action: "edit", text: "We can refund up to 50% of the last invoice." },
      "luka@zellify.app",
      500
    );
    expect(result).toEqual({
      result: "decided",
      row: expect.objectContaining({
        decision: "edited",
        editedText: "We can refund up to 50% of the last invoice.",
        rejectReason: null,
      }),
    });
  });

  it("reject records the reason", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const result = await decideApproval(
      env.DB,
      c.id,
      { action: "reject", reason: "we do not offer refunds on this plan" },
      "mikheil@zellify.app",
      500
    );
    expect(result).toEqual({
      result: "decided",
      row: expect.objectContaining({
        decision: "rejected",
        rejectReason: "we do not offer refunds on this plan",
        editedText: null,
      }),
    });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await decideApproval(
      env.DB,
      `apr:${crypto.randomUUID()}`,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );
    expect(result).toEqual({ result: "not_found" });
  });

  it("a second decision on an already-decided row is refused and returns the original", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );

    // Illegal transition approved -> rejected: unreachable because
    // decideApproval only CASes from 'pending'. Prove the row is untouched,
    // not merely that the call is refused.
    const attempt = await decideApproval(
      env.DB,
      c.id,
      { action: "reject", reason: "changed my mind" },
      "luka@zellify.app",
      200
    );
    expect(attempt.result).toBe("already_decided");
    if (attempt.result !== "already_decided") throw new Error("unreachable");
    expect(attempt.row.decision).toBe("approved");
    expect(attempt.row.decidedBy).toBe("ronit@zellify.app");
    expect(attempt.row.decidedAt).toBe(100);
    expect(attempt.row.rejectReason).toBeNull();

    const row = await getApproval(env.DB, c.id);
    expect(row).toEqual(attempt.row);
  });

  describe("refused at the contracts layer before any D1 write", () => {
    it("edit without text throws DecisionInputError and leaves the row pending", async () => {
      const runId = await seedRun();
      const c = card(runId);
      await insertApproval(env.DB, c);

      await expect(
        decideApproval(
          env.DB,
          c.id,
          { action: "edit", text: "" },
          "ronit@zellify.app",
          100
        )
      ).rejects.toThrow(DecisionInputError);

      const row = await getApproval(env.DB, c.id);
      expect(row?.decision).toBe("pending");
      expect(row?.decidedBy).toBeNull();
      expect(row?.decidedAt).toBeNull();
    });

    it("reject without reason throws DecisionInputError and leaves the row pending", async () => {
      const runId = await seedRun();
      const c = card(runId);
      await insertApproval(env.DB, c);

      await expect(
        decideApproval(
          env.DB,
          c.id,
          { action: "reject", reason: "   " },
          "ronit@zellify.app",
          100
        )
      ).rejects.toThrow(DecisionInputError);

      const row = await getApproval(env.DB, c.id);
      expect(row?.decision).toBe("pending");
    });
  });
});

describe("withdrawApproval", () => {
  it("withdraws a pending row", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    expect(await withdrawApproval(env.DB, c.id, 300)).toEqual({
      result: "withdrawn",
    });

    const row = await getApproval(env.DB, c.id);
    expect(row?.decision).toBe("withdrawn");
    expect(row?.updatedAt).toBe(300);
  });

  it("frees the partial-index slot so the run can escalate again", async () => {
    const runId = await seedRun();
    const first = card(runId);
    await insertApproval(env.DB, first);
    await withdrawApproval(env.DB, first.id, 300);

    const second = card(runId);
    expect(await insertApproval(env.DB, second)).toBe("created");
  });

  it("returns already_decided for a row a human already decided, without touching it", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );

    const result = await withdrawApproval(env.DB, c.id, 300);
    expect(result.result).toBe("already_decided");
    if (result.result !== "already_decided") throw new Error("unreachable");
    expect(result.row.decision).toBe("approved");

    const row = await getApproval(env.DB, c.id);
    expect(row?.decision).toBe("approved");
    expect(row?.updatedAt).not.toBe(300);
  });

  it("returns not_found for an unknown id", async () => {
    expect(
      await withdrawApproval(env.DB, `apr:${crypto.randomUUID()}`, 300)
    ).toEqual({
      result: "not_found",
    });
  });
});

describe("setDelivery", () => {
  it("moves along a legal from state", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );

    expect(
      await setDelivery(env.DB, c.id, ["none"], "sending", null, 150)
    ).toBe(true);
    expect((await getApproval(env.DB, c.id))?.delivery).toBe("sending");

    expect(
      await setDelivery(
        env.DB,
        c.id,
        ["sending"],
        "blocked",
        "identity_unavailable",
        160
      )
    ).toBe(true);
    const row = await getApproval(env.DB, c.id);
    expect(row?.delivery).toBe("blocked");
    expect(row?.updatedAt).toBe(160);
  });

  it("refuses to move from a state the row is not actually in", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );

    // Row's delivery is 'none'; claiming it is 'sending' must not succeed.
    expect(
      await setDelivery(env.DB, c.id, ["sending"], "sent", null, 150)
    ).toBe(false);
    expect((await getApproval(env.DB, c.id))?.delivery).toBe("none");
  });

  it("accepts any of several legal from states", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );
    await setDelivery(env.DB, c.id, ["none"], "sending", null, 150);

    expect(
      await setDelivery(
        env.DB,
        c.id,
        ["none", "sending"],
        "in_doubt",
        "timeout",
        160
      )
    ).toBe(true);
    expect((await getApproval(env.DB, c.id))?.delivery).toBe("in_doubt");
  });

  it("records the delivery error", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );
    await setDelivery(env.DB, c.id, ["none"], "sending", null, 150);
    await setDelivery(
      env.DB,
      c.id,
      ["sending"],
      "blocked",
      "identity_unavailable",
      160
    );

    const row = await env.DB.prepare(
      "SELECT delivery_error FROM approvals WHERE id = ?"
    )
      .bind(c.id)
      .first<{ delivery_error: string | null }>();
    expect(row?.delivery_error).toBe("identity_unavailable");
  });

  it("returns false for an unknown id", async () => {
    expect(
      await setDelivery(
        env.DB,
        `apr:${crypto.randomUUID()}`,
        ["none"],
        "sending",
        null,
        100
      )
    ).toBe(false);
  });

  it("treats an empty `from` set as a refused no-op", async () => {
    // WHAT THIS DOES AND DOES NOT PROVE, because the difference was measured
    // rather than assumed: deleting `setDelivery`'s `if (from.length === 0)`
    // guard leaves this case GREEN. SQLite (through D1) accepts `delivery IN
    // ()` and matches nothing, so the guard is a fast path, not the thing that
    // makes the call safe — an honest reading of it is "one statement saved",
    // not "a syntax error prevented".
    //
    // The case is still worth its four lines: it pins the CONTRACT that an
    // empty `from` is a refused no-op with the row untouched, which is what
    // every caller's branch on the boolean depends on, and which would stop
    // being true if the guard were ever changed to `return true` or if a future
    // engine rejected the empty list instead of matching nothing.
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    expect(await setDelivery(env.DB, c.id, [], "sent", null, 100)).toBe(false);
    expect(await getApproval(env.DB, c.id)).toMatchObject({
      delivery: "none",
      updatedAt: c.now,
    });
  });
});

describe("listOpen", () => {
  it("returns an empty array, not null, when there is nothing pending", async () => {
    expect(await listOpen(env.DB)).toEqual([]);
  });

  it("lists only pending rows", async () => {
    const runA = await seedRun();
    const runB = await seedRun();
    const pending = card(runA);
    const decided = card(runB);
    await insertApproval(env.DB, pending);
    await insertApproval(env.DB, decided);
    await decideApproval(
      env.DB,
      decided.id,
      { action: "approve" },
      "ronit@zellify.app",
      100
    );

    const open = await listOpen(env.DB);
    expect(open.map((r) => r.id)).toEqual([pending.id]);
  });

  it("respects an explicit limit", async () => {
    for (let i = 0; i < 3; i++) {
      const runId = await seedRun();
      await insertApproval(env.DB, card(runId));
    }
    expect(await listOpen(env.DB, 2)).toHaveLength(2);
  });
});

describe("listUndeliveredResolutions and markResolutionDelivered", () => {
  it("lists a decided row that has not yet been marked delivered", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "reject", reason: "no" },
      "ronit@zellify.app",
      100
    );

    const undelivered = await listUndeliveredResolutions(env.DB, 10);
    expect(undelivered.map((r) => r.id)).toContain(c.id);
  });

  it("excludes a pending row (nothing to resolve yet)", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const undelivered = await listUndeliveredResolutions(env.DB, 10);
    expect(undelivered.map((r) => r.id)).not.toContain(c.id);
  });

  it("drops off the list once markResolutionDelivered is called", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await decideApproval(
      env.DB,
      c.id,
      { action: "reject", reason: "no" },
      "ronit@zellify.app",
      100
    );

    await markResolutionDelivered(env.DB, c.id, 200);

    const undelivered = await listUndeliveredResolutions(env.DB, 10);
    expect(undelivered.map((r) => r.id)).not.toContain(c.id);

    const row = await env.DB.prepare(
      "SELECT resolution_delivered_at FROM approvals WHERE id = ?"
    )
      .bind(c.id)
      .first<{ resolution_delivered_at: number | null }>();
    expect(row?.resolution_delivered_at).toBe(200);
  });

  it("respects an explicit limit", async () => {
    for (let i = 0; i < 3; i++) {
      const runId = await seedRun();
      const c = card(runId);
      await insertApproval(env.DB, c);
      await decideApproval(
        env.DB,
        c.id,
        { action: "approve" },
        "ronit@zellify.app",
        100
      );
    }
    expect(await listUndeliveredResolutions(env.DB, 2)).toHaveLength(2);
  });
});

describe("row shape constraints fail closed", () => {
  it("refuses a kind other than slack_reply", async () => {
    const runId = await seedRun();
    await expect(
      env.DB.prepare(
        `INSERT INTO approvals
           (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow, created_at, updated_at)
         VALUES (?, ?, 'gen', 'linear_issue', 'draft', 'why', 'C1', 'ts', 0, 1, 1)`
      )
        .bind(`apr:${crypto.randomUUID()}`, runId)
        .run()
    ).rejects.toThrow();
  });

  it("refuses an unknown decision", async () => {
    const runId = await seedRun();
    await expect(
      env.DB.prepare(
        `INSERT INTO approvals
           (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow, decision, created_at, updated_at)
         VALUES (?, ?, 'gen', 'slack_reply', 'draft', 'why', 'C1', 'ts', 0, 'maybe', 1, 1)`
      )
        .bind(`apr:${crypto.randomUUID()}`, runId)
        .run()
    ).rejects.toThrow();
  });

  it("refuses a run_id with no matching run", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO approvals
           (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, shadow, created_at, updated_at)
         VALUES (?, ?, 'gen', 'slack_reply', 'draft', 'why', 'C1', 'ts', 0, 1, 1)`
      )
        .bind(`apr:${crypto.randomUUID()}`, `run_${crypto.randomUUID()}`)
        .run()
    ).rejects.toThrow();
  });
});

describe("claimNudge — exactly-once CAS", () => {
  it("returns true once and false on every retry", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    expect(await claimNudge(env.DB, c.id, 100)).toBe(true);
    expect(await claimNudge(env.DB, c.id, 200)).toBe(false);
    expect(await claimNudge(env.DB, c.id, 300)).toBe(false);

    const row = await getApproval(env.DB, c.id);
    expect(row?.nudgedAt).toBe(100);
  });

  it("two concurrent claims on a fresh row yield exactly one true", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);

    const [a, b] = await Promise.all([
      claimNudge(env.DB, c.id, 100),
      claimNudge(env.DB, c.id, 101),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("returns false for an unknown id", async () => {
    expect(await claimNudge(env.DB, `apr:${crypto.randomUUID()}`, 100)).toBe(
      false
    );
  });
});

describe("recordNudgeMessage", () => {
  it("stores channel and ts, readable via getApproval", async () => {
    const runId = await seedRun();
    const c = card(runId);
    await insertApproval(env.DB, c);
    await claimNudge(env.DB, c.id, 100);

    await recordNudgeMessage(env.DB, c.id, "C_ENG", "1720000000.000100");

    const row = await getApproval(env.DB, c.id);
    expect(row?.nudgeChannelId).toBe("C_ENG");
    expect(row?.nudgeTs).toBe("1720000000.000100");
  });
});

describe("the unnudged index feed", () => {
  it("returns the other pending rows, oldest first, once one is claimed", async () => {
    const runA = await seedRun();
    const runB = await seedRun();
    const runC = await seedRun();
    const first = card(runA, { now: 100 });
    const second = card(runB, { now: 200 });
    const third = card(runC, { now: 300 });
    await insertApproval(env.DB, first);
    await insertApproval(env.DB, second);
    await insertApproval(env.DB, third);

    await claimNudge(env.DB, second.id, 400);

    const { results } = await env.DB.prepare(
      `SELECT id FROM approvals WHERE decision = 'pending' AND nudged_at IS NULL ORDER BY created_at ASC`
    ).all<{ id: string }>();
    expect((results ?? []).map((r) => r.id)).toEqual([first.id, third.id]);
  });
});

// Kept as a type-only reference so `ApprovalRow` stays imported and this file
// fails to compile if the repository's return shape ever drifts from it.
function _typeCheck(row: ApprovalRow): string {
  return row.id;
}
void _typeCheck;
