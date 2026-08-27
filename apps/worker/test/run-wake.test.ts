import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTestModel, resetTestModel } from "../src/run/model";
import { getRunByKey, readRunUsage, setRunStatus } from "../src/run/repository";
import { slackRunKey } from "../src/run/keys";
import { createRunFromChat, routeToOwnedRun, wakeRun } from "../src/run/wake";
import { cannedModel } from "./helpers/canned-model";
import { waitFor } from "./helpers/wait";

/**
 * Every case mints its own channel id and thread ts: pool storage is shared
 * across tests AND files, and a reused `slack:{channel}:{thread}` key is a
 * reused Durable Object carrying another case's session.
 */
let seq = 0;
function freshChannel(mode: "live" | "observe" | "internal"): Promise<string> {
  seq += 1;
  const channelId = `CWAKE${seq}${Math.floor(Math.random() * 1e6)}`.toUpperCase().slice(0, 20);
  return env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'pulsefit', ?)",
  )
    .bind(channelId, `ext-${channelId.toLowerCase()}`, mode)
    .run()
    .then(() => channelId);
}

let ts = 1_720_000_000;
function freshThreadTs(): string {
  ts += 1;
  return `${ts}.000100`;
}

beforeEach(() => {
  // Without a model the submitted turn can never complete, and an object stuck
  // in a turn stops answering RPC — so every assertion past the submit needs
  // one. It never leaves the isolate.
  installTestModel(cannedModel());
});
afterEach(() => resetTestModel());

describe("waking a slack run", () => {
  it("writes the D1 row before the object is addressed", async () => {
    const channelId = await freshChannel("live");
    const threadTs = freshThreadTs();

    const outcome = await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "pulsefit says the exporter is stuck",
    });

    const run = await getRunByKey(env.DB, slackRunKey(channelId, threadTs));
    expect(run).not.toBeNull();
    expect(outcome.runId).toBe(run?.id);
    // The public id and the Durable Object name are different values, and the
    // key never leaves the Worker (invariant 10).
    expect(run?.id).not.toBe(run?.key);
  });

  it("shadows a run on a channel that may not be posted to", async () => {
    // The row carries the flag BEFORE any turn exists, which is what makes the
    // write guard's call-time re-read refuse the first external write rather
    // than the second (invariant 37).
    for (const [mode, shadow] of [
      ["live", false],
      ["observe", true],
      ["internal", true],
    ] as const) {
      const channelId = await freshChannel(mode);
      const threadTs = freshThreadTs();
      await wakeRun(env, {
        eventId: `Ev${crypto.randomUUID()}`,
        channelId,
        threadTs,
        openingPrompt: "look at this",
      });
      expect(await getRunByKey(env.DB, slackRunKey(channelId, threadTs))).toMatchObject({ shadow });
    }
  });

  it("shadows a run whose channel is not in the table at all", async () => {
    // Fail closed: an unmapped channel is never postable.
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId: "CUNMAPPED0",
      threadTs,
      openingPrompt: "look at this",
    });
    expect(await getRunByKey(env.DB, slackRunKey("CUNMAPPED0", threadTs))).toMatchObject({
      shadow: true,
    });
  });

  it("submits one turn however many times the same event is redelivered", async () => {
    const channelId = await freshChannel("live");
    const threadTs = freshThreadTs();
    const eventId = `Ev${crypto.randomUUID()}`;
    const wake = () =>
      wakeRun(env, { eventId, channelId, threadTs, openingPrompt: "the exporter is stuck" });

    expect((await wake()).accepted).toBe(true);
    // The queue is at-least-once and the stored triage decision is replayed on
    // every retry, so this is the ordinary case rather than the odd one.
    expect((await wake()).accepted).toBe(false);
    expect((await wake()).accepted).toBe(false);

    const runId = (await getRunByKey(env.DB, slackRunKey(channelId, threadTs)))?.id ?? "";
    const usage = await waitFor("the wake's usage row", async () => {
      const rows = await readRunUsage(env.DB, runId);
      return rows.length > 0 ? rows : null;
    });
    // One admitted submission, one turn, one model step billed.
    expect(usage[0].calls).toBe(1);
  });
});

describe("a message in a thread a run already owns", () => {
  function message(channelId: string, threadTs: string, over: Record<string, unknown> = {}) {
    return {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      ts: freshThreadTs(),
      threadTs,
      text: "still broken",
      userId: "U1",
      permalink: null,
      ...over,
    };
  }

  it("absorbs the message and reports it committed", async () => {
    const channelId = await freshChannel("live");
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "opening",
    });

    // True only when the message has been COMMITTED as a turn. "Found but not
    // stored" would make triage skip the message and nothing would hold it.
    expect(await routeToOwnedRun(env, message(channelId, threadTs))).toBe(true);
  });

  it("releases a thread whose run is done or failed", async () => {
    for (const status of ["done", "failed"] as const) {
      const channelId = await freshChannel("live");
      const threadTs = freshThreadTs();
      await wakeRun(env, {
        eventId: `Ev${crypto.randomUUID()}`,
        channelId,
        threadTs,
        openingPrompt: "opening",
      });
      const key = slackRunKey(channelId, threadTs);
      await setRunStatus(env.DB, (await getRunByKey(env.DB, key))?.id ?? "", status);

      // Back to triage, which may reopen this same key and keep the history.
      expect(await routeToOwnedRun(env, message(channelId, threadTs))).toBe(false);
    }
  });

  it("bumps the run's input revision, which is what makes supersession work", async () => {
    // A turn still answering revision N is stale the moment N+1 exists, and
    // `beforeToolCall` and the capability freshness guard both read that. The
    // customer's follow-up is what stops the work in flight.
    const channelId = await freshChannel("live");
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "opening",
    });
    const stub = await getAgentByName(env.RUN_AGENTS, slackRunKey(channelId, threadTs));
    const before = (await stub.runStateForTest()).inputRevision;

    await routeToOwnedRun(env, message(channelId, threadTs));
    await routeToOwnedRun(env, message(channelId, threadTs));

    expect((await stub.runStateForTest()).inputRevision).toBe(before + 2);
  });

  it("finds nothing when no run owns the thread", async () => {
    const channelId = await freshChannel("live");
    expect(await routeToOwnedRun(env, message(channelId, freshThreadTs()))).toBe(false);
  });

  it("ratchets a continuing run to shadow when its channel was downgraded", async () => {
    // Continuation bypasses triage. It does NOT bypass policy: the run was
    // created while the channel could be posted to and must stop being able to.
    const channelId = await freshChannel("live");
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "opening",
    });
    const key = slackRunKey(channelId, threadTs);
    expect(await getRunByKey(env.DB, key)).toMatchObject({ shadow: false });

    await env.DB.prepare("UPDATE channels SET mode = 'observe' WHERE channel_id = ?")
      .bind(channelId)
      .run();
    await routeToOwnedRun(env, message(channelId, threadTs));

    expect(await getRunByKey(env.DB, key)).toMatchObject({ shadow: true });
  });

  it("never clears a shadow it once set", async () => {
    // There is deliberately no code path anywhere that turns a shadow run back
    // into an acting one. Promotion is an authority change and belongs in a
    // reviewed operation, not in the path a redelivered Slack event takes.
    const channelId = await freshChannel("observe");
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt: "opening",
    });
    await env.DB.prepare("UPDATE channels SET mode = 'live' WHERE channel_id = ?")
      .bind(channelId)
      .run();
    await routeToOwnedRun(env, message(channelId, threadTs));

    expect(await getRunByKey(env.DB, slackRunKey(channelId, threadTs))).toMatchObject({
      shadow: true,
    });
  });
});

describe("a run started from the dashboard", () => {
  it("mints a chat key whose public id is a different value", async () => {
    const { runId } = await createRunFromChat(env, { firstMessage: "why is the exporter stuck?" });
    const { results } = await env.DB.prepare('SELECT "key", origin FROM runs WHERE id = ?')
      .bind(runId)
      .all<{ key: string; origin: string }>();

    expect(results?.[0].origin).toBe("chat");
    expect(results?.[0].key).toMatch(/^chat:[0-9a-f-]{36}$/);
    expect(results?.[0].key).not.toContain(runId);
  });

  it("submits nothing when there is no first message", async () => {
    const { runId } = await createRunFromChat(env, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readRunUsage(env.DB, runId)).toEqual([]);
  });

  it("is never shadowed, because a chat run has no channel to police", async () => {
    const { runId } = await createRunFromChat(env, {});
    const { results } = await env.DB.prepare("SELECT shadow FROM runs WHERE id = ?")
      .bind(runId)
      .all<{ shadow: number }>();
    expect(results?.[0].shadow).toBe(0);
  });
});

describe("an object that was never told who it is", () => {
  it("resolves its own run id from D1 on start", async () => {
    // The wake path binds it explicitly, but a dashboard socket, an approval
    // resolution and a scheduled callback after an eviction all reach the
    // object without going through a wake.
    const { runId } = await createRunFromChat(env, {});
    const key = (
      await env.DB.prepare('SELECT "key" FROM runs WHERE id = ?').bind(runId).first<{ key: string }>()
    )?.key;

    const stub = await getAgentByName(env.RUN_AGENTS, key ?? "");
    expect((await stub.runStateForTest()).runId).toBe(runId);
  });

  it("leaves itself unbound when the index has no row for it", async () => {
    // Not an error and not a guess: `#runId()` refuses honestly until a wake
    // writes the row, and a throw out of onStart would make the object
    // permanently unreachable rather than temporarily unbound.
    const stub = await getAgentByName(env.RUN_AGENTS, `chat:${crypto.randomUUID()}`);
    expect((await stub.runStateForTest()).runId).toBeNull();
  });
});
