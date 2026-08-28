import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { chatRunKey, slackRunKey } from "../../src/run/keys";
import {
  createOrGetRun,
  createOrGetRunUnderPolicy,
  decodeRunCursor,
  encodeRunCursor,
  findOwnedSlackRun,
  getRunById,
  getRunByKey,
  listRuns,
  projectRunIndex,
  RUN_LIST_MAX_LIMIT,
  setRunStatus,
  touchRun,
} from "../../src/run/repository";

// D1 is shared across every suite in this pool (see phase-08-notes.md), so each
// case works on ids it generated itself and the table is cleared up front.
beforeEach(async () => {
  // Both reference `runs.id` with no ON DELETE clause (agent billing history
  // and approval decisions must not silently vanish in production), so a
  // wipe here has to clear them BEFORE `runs` or D1 enforces the FK and the
  // whole beforeEach throws — which then fails every subsequent test in this
  // file, not just the one that seeded the row.
  await env.DB.prepare("DELETE FROM agent_model_calls").run();
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM runs").run();
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'pulsefit-eng', 'pulsefit', 'live')"
  ).run();
});

function slackDescriptor(threadTs = "1720000000.123456") {
  return {
    key: slackRunKey("C1", threadTs),
    origin: "slack" as const,
    channelId: "C1",
    threadTs,
  };
}

function chatDescriptor(chatId = crypto.randomUUID()) {
  return {
    key: chatRunKey(chatId),
    origin: "chat" as const,
    channelId: null,
    threadTs: null,
  };
}

describe("createOrGetRun", () => {
  it("creates a run with a server-generated uuid distinct from its key", async () => {
    const descriptor = chatDescriptor();
    const run = await createOrGetRun(env.DB, descriptor);

    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.key).toBe(descriptor.key);
    // Invariant 10: the public id must not be convertible into the DO name.
    expect(descriptor.key).not.toContain(run.id);
    // Idle for every origin: creating an index row is not the agent working.
    expect(run.status).toBe("idle");
    expect(run.shadow).toBe(false);
    expect(run.summary).toBeNull();
  });

  /**
   * `createOrGetRun` is now `createOrGetRunUnderPolicy` with the ratchet bound
   * off, rather than a verbatim second copy of the same INSERT. These three
   * cases are what makes that safe to have done, and they are written against
   * real D1 rather than by reading the SQL.
   *
   * The third is the one that would actually be a bug. `createOrGetRun` used to
   * contain no statement that touched `shadow` at all; the delegate contains
   * one, and if its `AND ? = 1` guard were ever dropped, an ordinary
   * policy-free create would CLEAR a shadow. Invariant 37 rests on nothing in
   * this Worker ever setting `shadow` back to 0.
   */
  describe("delegates to createOrGetRunUnderPolicy without changing behaviour", () => {
    it("creates an unshadowed row, exactly as the policy-aware version does", async () => {
      const direct = await createOrGetRun(env.DB, chatDescriptor());
      const viaPolicy = await createOrGetRunUnderPolicy(
        env.DB,
        chatDescriptor(),
        { mustShadow: false }
      );

      expect(direct.shadow).toBe(false);
      expect(viaPolicy.shadow).toBe(false);
      expect(direct.status).toBe(viaPolicy.status);
      expect(direct.summary).toBe(viaPolicy.summary);
    });

    it("leaves an existing unshadowed row alone", async () => {
      const descriptor = slackDescriptor();
      const first = await createOrGetRun(env.DB, descriptor);
      const again = await createOrGetRun(env.DB, descriptor);

      expect(again.id).toBe(first.id);
      expect(again.shadow).toBe(false);
    });

    it("NEVER clears an existing shadow", async () => {
      const descriptor = slackDescriptor();
      const shadowed = await createOrGetRunUnderPolicy(env.DB, descriptor, {
        mustShadow: true,
      });
      expect(shadowed.shadow).toBe(true);

      // The policy-free create, on a row that is already shadowed. The ratchet
      // is one-way; this must be a no-op.
      const after = await createOrGetRun(env.DB, descriptor);
      expect(after.id).toBe(shadowed.id);
      expect(after.shadow).toBe(true);

      const row = await env.DB.prepare(
        'SELECT shadow FROM runs WHERE "key" = ?'
      )
        .bind(descriptor.key)
        .first<{ shadow: number }>();
      expect(row?.shadow).toBe(1);
    });
  });

  it("is idempotent on the origin key and keeps the original uuid", async () => {
    const descriptor = slackDescriptor();
    const first = await createOrGetRun(env.DB, descriptor);
    const second = await createOrGetRun(env.DB, descriptor);

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    const { results } = await env.DB.prepare("SELECT id FROM runs").all();
    expect(results).toHaveLength(1);
  });

  it("does not return the losing candidate uuid on a concurrent create", async () => {
    const descriptor = slackDescriptor();
    const [a, b, c] = await Promise.all([
      createOrGetRun(env.DB, descriptor),
      createOrGetRun(env.DB, descriptor),
      createOrGetRun(env.DB, descriptor),
    ]);

    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{
      n: number;
    }>();
    expect(row?.n).toBe(1);
  });

  it("gives a second thread in the same channel a second run", async () => {
    const first = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000000.123456")
    );
    const second = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000099.123456")
    );
    expect(second.id).not.toBe(first.id);
  });

  it("round-trips a slack run through both lookups", async () => {
    const descriptor = slackDescriptor();
    const created = await createOrGetRun(env.DB, descriptor);

    expect(await getRunById(env.DB, created.id)).toEqual(created);
    expect(await getRunByKey(env.DB, descriptor.key)).toEqual(created);
  });

  it("returns null rather than throwing for a missing run", async () => {
    expect(await getRunById(env.DB, crypto.randomUUID())).toBeNull();
    expect(
      await getRunByKey(env.DB, chatRunKey(crypto.randomUUID()))
    ).toBeNull();
  });
});

describe("row shape constraints fail closed", () => {
  it("refuses a slack run without a channel or thread", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'slack', NULL, NULL, 'live', 0, 1, 1)`
      )
        .bind(crypto.randomUUID(), "slack:C1:1720000000.123456")
        .run()
    ).rejects.toThrow();
  });

  it("refuses a chat run carrying a channel", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', 'C1', '1720000000.123456', 'live', 0, 1, 1)`
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run()
    ).rejects.toThrow();
  });

  it("refuses an unknown status", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'running', 0, 1, 1)`
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run()
    ).rejects.toThrow();
  });

  it("refuses a non-boolean shadow", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'live', 2, 1, 1)`
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run()
    ).rejects.toThrow();
  });

  it("refuses a duplicate origin key", async () => {
    const key = chatRunKey(crypto.randomUUID());
    const insert = () =>
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'live', 0, 1, 1)`
      )
        .bind(crypto.randomUUID(), key)
        .run();

    await insert();
    await expect(insert()).rejects.toThrow();
  });
});

describe("findOwnedSlackRun", () => {
  it.each(["live", "awaiting_approval", "idle"] as const)(
    "claims the thread while %s",
    async (status) => {
      const descriptor = slackDescriptor();
      const run = await createOrGetRun(env.DB, descriptor);
      await setRunStatus(env.DB, run.id, status);

      const found = await findOwnedSlackRun(env.DB, "C1", descriptor.threadTs);
      expect(found?.id).toBe(run.id);
    }
  );

  it.each(["done", "failed"] as const)(
    "releases the thread once %s",
    async (status) => {
      const descriptor = slackDescriptor();
      const run = await createOrGetRun(env.DB, descriptor);
      await setRunStatus(env.DB, run.id, status);

      // Triage must run again — and may reopen this very run through its key.
      expect(
        await findOwnedSlackRun(env.DB, "C1", descriptor.threadTs)
      ).toBeNull();
      expect((await getRunByKey(env.DB, descriptor.key))?.id).toBe(run.id);
    }
  );

  it("does not match a different thread or channel", async () => {
    const descriptor = slackDescriptor();
    await createOrGetRun(env.DB, descriptor);

    expect(
      await findOwnedSlackRun(env.DB, "C1", "1720000099.123456")
    ).toBeNull();
    expect(
      await findOwnedSlackRun(env.DB, "C9", descriptor.threadTs)
    ).toBeNull();
  });

  it("never matches a chat run", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    expect(
      await findOwnedSlackRun(env.DB, "C1", "1720000000.123456")
    ).toBeNull();
  });
});

describe("listRuns", () => {
  it("returns an empty array, not null, on an empty table", async () => {
    expect((await listRuns(env.DB, {})).runs).toEqual([]);
  });

  it("orders by updated_at descending", async () => {
    const older = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000000.123456")
    );
    const newer = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000099.123456")
    );

    await touchRun(env.DB, older.id, 1_000);
    await touchRun(env.DB, newer.id, 2_000);

    const listed = (await listRuns(env.DB, {})).runs;
    expect(listed.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("joins channel display data for slack runs", async () => {
    const run = await createOrGetRun(env.DB, slackDescriptor());
    const [item] = (await listRuns(env.DB, {})).runs;

    expect(item.id).toBe(run.id);
    expect(item.channelName).toBe("pulsefit-eng");
    expect(item.customerSlug).toBe("pulsefit");
  });

  it("leaves display data null for chat runs", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    const [item] = (await listRuns(env.DB, {})).runs;

    expect(item.channelName).toBeNull();
    expect(item.customerSlug).toBeNull();
  });

  it("filters by status", async () => {
    const live = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000000.123456")
    );
    const done = await createOrGetRun(
      env.DB,
      slackDescriptor("1720000099.123456")
    );
    await setRunStatus(env.DB, live.id, "live");
    await setRunStatus(env.DB, done.id, "done");

    const listed = (await listRuns(env.DB, { status: "live" })).runs;
    expect(listed.map((r) => r.id)).toEqual([live.id]);
  });

  it("caps the limit rather than trusting the caller", async () => {
    for (let i = 0; i < 5; i++) {
      await createOrGetRun(env.DB, chatDescriptor());
    }
    expect((await listRuns(env.DB, { limit: 2 })).runs).toHaveLength(2);
    expect((await listRuns(env.DB, { limit: 10_000 })).runs).toHaveLength(5);
    expect(RUN_LIST_MAX_LIMIT).toBeLessThanOrEqual(200);
  });

  it("never exposes the private origin key", async () => {
    await createOrGetRun(env.DB, slackDescriptor());
    const [item] = (await listRuns(env.DB, {})).runs;
    expect(Object.keys(item)).not.toContain("key");
  });

  // `idx_agent_model_step` is UNIQUE on (generation_id, attempt, step_index)
  // with no run_id in it (migration 0006) — it is the model's retry
  // idempotency key, not scoped per run. The brief's fixture pins attempt and
  // step_index to 0 for every call; seeding more than one row under the same
  // generation_id, as the spend test below does, collides on that index
  // rather than on anything this test is trying to exercise. A per-call
  // step_index keeps every other column exactly as specified.
  let seedStepIndex = 0;
  async function seedModelCall(runId: string, turnId: string, nano: number) {
    await env.DB.prepare(
      `INSERT INTO agent_model_calls
        (id, run_id, generation_id, agent_turn_id, attempt, step_index, provider, model,
         input_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
         reasoning_tokens, total_tokens, cost_nano_usd, latency_ms, created_at)
       VALUES (?, ?, 'gen:1', ?, 0, ?, 'anthropic', 'claude-fable-5',
               10, 10, 0, 0, 5, 0, 15, ?, 100, 1)`
    )
      .bind(
        `usage:${crypto.randomUUID()}`,
        runId,
        turnId,
        seedStepIndex++,
        nano
      )
      .run();
  }

  it("carries spend as a decimal string, a distinct-turn count, and the open approval", async () => {
    const run = await createOrGetRun(env.DB, slackDescriptor());
    await seedModelCall(run.id, "turn:a", 1_500_000_000);
    await seedModelCall(run.id, "turn:a", 500_000_000);
    await seedModelCall(run.id, "turn:b", 1);
    await env.DB.prepare(
      `INSERT INTO approvals
         (id, run_id, generation_id, kind, draft, why, channel_id, thread_ts, created_at, updated_at)
       VALUES ('apr:list-1', ?, 'gen:1', 'slack_reply', 'd', 'w', 'C1', '1', 1, 1)`
    )
      .bind(run.id)
      .run();

    const [item] = (await listRuns(env.DB, {})).runs;
    expect(item.costUsd).toBe("2.000000001");
    expect(item.turns).toBe(2);
    expect(item.openApprovalId).toBe("apr:list-1");
  });

  it("reports zero spend and no approval for a run that has neither", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    const [item] = (await listRuns(env.DB, {})).runs;
    expect(item.costUsd).toBe("0.000000000");
    expect(item.turns).toBe(0);
    expect(item.openApprovalId).toBeNull();
  });

  it("filters by origin, channel and shadow", async () => {
    const slack = await createOrGetRun(env.DB, slackDescriptor());
    const chat = await createOrGetRun(env.DB, chatDescriptor());
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?")
      .bind(chat.id)
      .run();

    expect(
      (await listRuns(env.DB, { origin: "chat" })).runs.map((r) => r.id)
    ).toEqual([chat.id]);
    expect(
      (await listRuns(env.DB, { channelId: "C1" })).runs.map((r) => r.id)
    ).toEqual([slack.id]);
    expect(
      (await listRuns(env.DB, { shadow: true })).runs.map((r) => r.id)
    ).toEqual([chat.id]);
    expect(
      (await listRuns(env.DB, { shadow: false })).runs.map((r) => r.id)
    ).toEqual([slack.id]);
  });

  it("searches summary, channel name and id prefix", async () => {
    const slack = await createOrGetRun(env.DB, slackDescriptor());
    const chat = await createOrGetRun(env.DB, chatDescriptor());
    await env.DB.prepare("UPDATE runs SET summary = ? WHERE id = ?")
      .bind("checkout button does nothing on Android", chat.id)
      .run();

    expect(
      (await listRuns(env.DB, { q: "android" })).runs.map((r) => r.id)
    ).toEqual([chat.id]);
    expect(
      (await listRuns(env.DB, { q: "pulsefit-eng" })).runs.map((r) => r.id)
    ).toEqual([slack.id]);
    expect(
      (await listRuns(env.DB, { q: slack.id.slice(0, 8) })).runs.map(
        (r) => r.id
      )
    ).toEqual([slack.id]);
    // `%` is a literal, not a wildcard.
    expect((await listRuns(env.DB, { q: "%" })).runs).toEqual([]);
  });

  it("pages with a keyset cursor and never repeats or skips a row", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const run = await createOrGetRun(
        env.DB,
        slackDescriptor(`172000000${i}.000001`)
      );
      // Two rows share an updated_at so the (updated_at, id) tiebreak is exercised.
      await touchRun(env.DB, run.id, i < 2 ? 1_000 : 1_000 + i);
      ids.push(run.id);
    }

    const first = await listRuns(env.DB, { limit: 2 });
    expect(first.runs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRuns(env.DB, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.runs).toHaveLength(2);
    const third = await listRuns(env.DB, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.runs).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.runs, ...second.runs, ...third.runs].map(
      (r) => r.id
    );
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("round-trips a cursor and rejects a malformed one", async () => {
    expect(
      decodeRunCursor(encodeRunCursor({ updatedAt: 42, id: "abc" }))
    ).toEqual({ updatedAt: 42, id: "abc" });
    expect(decodeRunCursor("nonsense")).toBeNull();
    expect(decodeRunCursor("x_abc")).toBeNull();
  });
});

describe("touchRun and setRunStatus", () => {
  it("moves updated_at without touching created_at", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    await touchRun(env.DB, run.id, run.updatedAt + 5_000);

    const after = await getRunById(env.DB, run.id);
    expect(after?.updatedAt).toBe(run.updatedAt + 5_000);
    expect(after?.createdAt).toBe(run.createdAt);
  });

  it("never moves updated_at backwards", async () => {
    // A retry replaying an older event must not make a run look stale and drop
    // it down the dashboard list.
    const run = await createOrGetRun(env.DB, chatDescriptor());
    await touchRun(env.DB, run.id, run.updatedAt + 5_000);
    await touchRun(env.DB, run.id, run.updatedAt - 5_000);

    const after = await getRunById(env.DB, run.id);
    expect(after?.updatedAt).toBe(run.updatedAt + 5_000);
  });

  it("tolerates a missing run so a DO mutation is not failed by its index", async () => {
    await expect(
      touchRun(env.DB, crypto.randomUUID(), 1_000)
    ).resolves.toBeUndefined();
  });

  it("records a status change", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    await setRunStatus(env.DB, run.id, "awaiting_approval");
    expect((await getRunById(env.DB, run.id))?.status).toBe(
      "awaiting_approval"
    );
  });
});

describe("projectRunIndex", () => {
  it("carries status, summary and recency across as one bundle", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    const applied = await projectRunIndex(env.DB, run.id, 1, {
      status: "live",
      summary: "chasing a stuck deploy",
      updatedAt: run.updatedAt + 1_000,
    });

    expect(applied).toEqual({ applied: true });
    const after = await getRunById(env.DB, run.id);
    // The Phase 08 bug: setSummary only touched updated_at, so the list stayed
    // blank no matter how many summaries the run produced.
    expect(after).toMatchObject({
      status: "live",
      summary: "chasing a stuck deploy",
    });
    expect(after?.updatedAt).toBe(run.updatedAt + 1_000);
  });

  it("ignores an older revision whose write returned late", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    // Reversed completion order: revision 2's write lands first.
    await projectRunIndex(env.DB, run.id, 2, {
      status: "done",
      summary: "finished",
      updatedAt: run.updatedAt + 2_000,
    });
    const stale = await projectRunIndex(env.DB, run.id, 1, {
      status: "live",
      summary: "still working",
      updatedAt: run.updatedAt + 1_000,
    });

    expect(stale).toEqual({ applied: false });
    const after = await getRunById(env.DB, run.id);
    expect(after).toMatchObject({ status: "done", summary: "finished" });
    expect(after?.updatedAt).toBe(run.updatedAt + 2_000);
  });

  it("orders two updates that share a millisecond", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    const at = run.updatedAt + 5_000;

    // Identical timestamps. A projector comparing time would tie here and let
    // whichever write arrived last win, regardless of which was newer.
    await projectRunIndex(env.DB, run.id, 7, {
      status: "live",
      summary: "newer",
      updatedAt: at,
    });
    const older = await projectRunIndex(env.DB, run.id, 6, {
      status: "idle",
      summary: "older",
      updatedAt: at,
    });

    expect(older).toEqual({ applied: false });
    expect((await getRunById(env.DB, run.id))?.summary).toBe("newer");
  });

  it("never moves recency backwards even for a newer revision", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    await projectRunIndex(env.DB, run.id, 1, {
      status: "live",
      summary: null,
      updatedAt: run.updatedAt + 9_000,
    });
    await projectRunIndex(env.DB, run.id, 2, {
      status: "idle",
      summary: null,
      updatedAt: run.updatedAt + 1_000,
    });

    const after = await getRunById(env.DB, run.id);
    expect(after?.status).toBe("idle");
    expect(after?.updatedAt).toBe(run.updatedAt + 9_000);
  });

  it("tolerates a missing run so a DO mutation is not failed by its index", async () => {
    await expect(
      projectRunIndex(env.DB, crypto.randomUUID(), 1, {
        status: "live",
        summary: null,
        updatedAt: 1_000,
      })
    ).resolves.toEqual({ applied: false });
  });
});
