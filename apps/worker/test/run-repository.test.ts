import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOrGetRun,
  findOwnedSlackRun,
  getRunById,
  getRunByKey,
  listRuns,
  setRunStatus,
  touchRun,
  RUN_LIST_MAX_LIMIT,
} from "../src/run/repository";
import { chatRunKey, slackRunKey } from "../src/run/keys";

// D1 is shared across every suite in this pool (see phase-08-notes.md), so each
// case works on ids it generated itself and the table is cleared up front.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM runs").run();
  await env.DB.prepare("DELETE FROM channels").run();
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES ('C1', 'pulsefit-eng', 'pulsefit', 'live')",
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
    expect(run.status).toBe("live");
    expect(run.shadow).toBe(false);
    expect(run.summary).toBeNull();
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

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("gives a second thread in the same channel a second run", async () => {
    const first = await createOrGetRun(env.DB, slackDescriptor("1720000000.123456"));
    const second = await createOrGetRun(env.DB, slackDescriptor("1720000099.123456"));
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
    expect(await getRunByKey(env.DB, chatRunKey(crypto.randomUUID()))).toBeNull();
  });
});

describe("row shape constraints fail closed", () => {
  it("refuses a slack run without a channel or thread", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'slack', NULL, NULL, 'live', 0, 1, 1)`,
      )
        .bind(crypto.randomUUID(), "slack:C1:1720000000.123456")
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a chat run carrying a channel", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', 'C1', '1720000000.123456', 'live', 0, 1, 1)`,
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run(),
    ).rejects.toThrow();
  });

  it("refuses an unknown status", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'running', 0, 1, 1)`,
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a non-boolean shadow", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'live', 2, 1, 1)`,
      )
        .bind(crypto.randomUUID(), chatRunKey(crypto.randomUUID()))
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a duplicate origin key", async () => {
    const key = chatRunKey(crypto.randomUUID());
    const insert = () =>
      env.DB.prepare(
        `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
         VALUES (?, ?, 'chat', NULL, NULL, 'live', 0, 1, 1)`,
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
    },
  );

  it.each(["done", "failed"] as const)("releases the thread once %s", async (status) => {
    const descriptor = slackDescriptor();
    const run = await createOrGetRun(env.DB, descriptor);
    await setRunStatus(env.DB, run.id, status);

    // Triage must run again — and may reopen this very run through its key.
    expect(await findOwnedSlackRun(env.DB, "C1", descriptor.threadTs)).toBeNull();
    expect((await getRunByKey(env.DB, descriptor.key))?.id).toBe(run.id);
  });

  it("does not match a different thread or channel", async () => {
    const descriptor = slackDescriptor();
    await createOrGetRun(env.DB, descriptor);

    expect(await findOwnedSlackRun(env.DB, "C1", "1720000099.123456")).toBeNull();
    expect(await findOwnedSlackRun(env.DB, "C9", descriptor.threadTs)).toBeNull();
  });

  it("never matches a chat run", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    expect(await findOwnedSlackRun(env.DB, "C1", "1720000000.123456")).toBeNull();
  });
});

describe("listRuns", () => {
  it("returns an empty array, not null, on an empty table", async () => {
    expect(await listRuns(env.DB, {})).toEqual([]);
  });

  it("orders by updated_at descending", async () => {
    const older = await createOrGetRun(env.DB, slackDescriptor("1720000000.123456"));
    const newer = await createOrGetRun(env.DB, slackDescriptor("1720000099.123456"));

    await touchRun(env.DB, older.id, 1_000);
    await touchRun(env.DB, newer.id, 2_000);

    const listed = await listRuns(env.DB, {});
    expect(listed.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("joins channel display data for slack runs", async () => {
    const run = await createOrGetRun(env.DB, slackDescriptor());
    const [item] = await listRuns(env.DB, {});

    expect(item.id).toBe(run.id);
    expect(item.channelName).toBe("pulsefit-eng");
    expect(item.customerSlug).toBe("pulsefit");
  });

  it("leaves display data null for chat runs", async () => {
    await createOrGetRun(env.DB, chatDescriptor());
    const [item] = await listRuns(env.DB, {});

    expect(item.channelName).toBeNull();
    expect(item.customerSlug).toBeNull();
  });

  it("filters by status", async () => {
    const live = await createOrGetRun(env.DB, slackDescriptor("1720000000.123456"));
    const done = await createOrGetRun(env.DB, slackDescriptor("1720000099.123456"));
    await setRunStatus(env.DB, done.id, "done");

    const listed = await listRuns(env.DB, { status: "live" });
    expect(listed.map((r) => r.id)).toEqual([live.id]);
  });

  it("caps the limit rather than trusting the caller", async () => {
    for (let i = 0; i < 5; i++) {
      await createOrGetRun(env.DB, chatDescriptor());
    }
    expect(await listRuns(env.DB, { limit: 2 })).toHaveLength(2);
    expect(await listRuns(env.DB, { limit: 10_000 })).toHaveLength(5);
    expect(RUN_LIST_MAX_LIMIT).toBeLessThanOrEqual(200);
  });

  it("never exposes the private origin key", async () => {
    await createOrGetRun(env.DB, slackDescriptor());
    const [item] = await listRuns(env.DB, {});
    expect(Object.keys(item)).not.toContain("key");
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
    await expect(touchRun(env.DB, crypto.randomUUID(), 1_000)).resolves.toBeUndefined();
  });

  it("records a status change", async () => {
    const run = await createOrGetRun(env.DB, chatDescriptor());
    await setRunStatus(env.DB, run.id, "awaiting_approval");
    expect((await getRunById(env.DB, run.id))?.status).toBe("awaiting_approval");
  });
});
