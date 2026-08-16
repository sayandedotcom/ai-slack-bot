import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";
import { wakeRun } from "../src/run/chassis";
import { canonicalThreadTs, slackRunKey } from "../src/run/keys";
import { createOrGetRun, getRunByKey } from "../src/run/repository";

/**
 * A FRESH key per case, WITH its D1 `runs` row. Pool storage is shared across
 * tests and files (no `isolatedStorage`), so a reused key would carry another
 * case's session.
 *
 * The row is written BEFORE the agent is addressed, and that ordering is the
 * point rather than tidiness: the run's trust envelope is resolved from D1 in
 * the Durable Object's constructor, and a run the index cannot confirm gets no
 * capabilities at all (see the refusal case at the bottom of this file).
 */
async function agentFor() {
  const key = `chat:${crypto.randomUUID()}`;
  await createOrGetRun(env.DB, { key, origin: "chat", channelId: null, threadTs: null });
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
}

/** The same, but the key comes back too — the identity cases need it. */
async function chatRunFor(): Promise<{ key: string; runId: string }> {
  const key = `chat:${crypto.randomUUID()}`;
  const record = await createOrGetRun(env.DB, {
    key,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return { key, runId: record.id };
}

/** A fresh Slack channel id and root `ts`, unique per case. */
function freshSlackThread(): { channelId: string; rootTs: string } {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const micros = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return { channelId, rootTs: `${Math.floor(Date.now() / 1000)}.${micros}` };
}

/** One user message, the smallest thing the session will persist. */
function userMessage(text: string): UIMessage {
  return { id: `msg_${crypto.randomUUID()}`, role: "user", parts: [{ type: "text", text }] };
}

/** `getMessages()` reads as `never` through the stub's RPC type mapping. */
async function messagesOf(agent: { getMessages(): Promise<unknown> }): Promise<UIMessage[]> {
  return (await agent.getMessages()) as unknown as UIMessage[];
}

function textsOf(messages: UIMessage[]): string[] {
  return messages.flatMap((message) =>
    message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text),
  );
}

describe("RunAgent core", () => {
  it("exposes exactly one model-facing tool, run_code", async () => {
    const agent = await agentFor();
    // Invariant 5. Think merges workspace bash, fetch and MCP tools into the
    // same map by default, and none of them would pass the write guard.
    expect(await agent.toolNames()).toEqual(["run_code"]);
  });

  it("ships neither a state filesystem nor a cdp browser to the sandbox", async () => {
    const agent = await agentFor();
    const names = await agent.connectorNames();

    // Verified fact 3a. `createExecuteRuntime` merges `optionsFromAgent(agent)`
    // UNDER the overrides, and that derives `state` from `this.workspace` --
    // which Think defaults to a real DO-SQLite Workspace -- and `browser` from
    // env.BROWSER. Only `state: undefined, browser: undefined` in the overrides
    // keeps them out; `workspaceBash = false` does not. This asserts on the
    // connector set the runtime was actually built from, so it fails if either
    // override is ever dropped.
    expect(names).not.toContain("state");
    expect(names).not.toContain("cdp");
    // ...and the eleven real namespaces are all still there.
    expect(names).toContain("slack");
    expect(names).toContain("github");
    expect(names).toHaveLength(11);
  });

  it("runs model-authored code and returns its value", async () => {
    const agent = await agentFor();
    // A REAL execution, not a keys-only check: `facets.get` is lazy, so tool
    // construction succeeds against a broken facet class and only this proves
    // the codemode runtime actually boots (verified fact 4b).
    const out = await agent.executeForTest("return 2 + 3");
    expect(out.status).toBe("completed");
    expect(out).toMatchObject({ result: 5 });
  });

  it("refuses to build a scope for a run the index cannot confirm", async () => {
    // NO `runs` row for this key. The failure this guards is silent: the scope
    // used to fill `customerSlug`, `actor` and the public run id with
    // placeholders, so the capabilities were built anyway and every one of
    // them had to be trusted to notice. A wrong `customerSlug` is a
    // cross-customer read, so an unconfirmable run gets no capabilities.
    const orphan = await getAgentByName<Env, RunAgent>(
      env.RUN_AGENTS,
      `chat:${crypto.randomUUID()}`,
    );

    // `.then(ok, err)` rather than `expect(...).rejects`: a rejected RPC stub
    // promise that is only inspected by `rejects` also surfaces as an
    // UNHANDLED rejection in the workers pool, which fails the run.
    const connectors = await orphan.connectorNames().then(
      () => "built a scope",
      (error: unknown) => String(error),
    );
    const tools = await orphan.toolNames().then(
      () => "built a scope",
      (error: unknown) => String(error),
    );

    expect(connectors).toMatch(/invalid_context/);
    expect(tools).toMatch(/invalid_context/);
  });
});

/* -------------------------------------------------------------- identity -- */

/**
 * The legacy chassis pins these three in `test/run-do.test.ts` § "namespace
 * identity", against `runStubForKey` + `idFromName`. `RunAgent` is reached
 * through the Agents SDK's `getAgentByName` instead, which is a DIFFERENT name
 * derivation, so none of that carries over by inspection. Two runs sharing one
 * object interleave two customers' threads; one thread split across two objects
 * answers the same customer twice from two transcripts. Both are silent.
 */
describe("RunAgent namespace identity", () => {
  it("resolves the same key to the same session, and a slack key and a chat key to different ones", async () => {
    const chat = await chatRunFor();
    const { channelId, rootTs } = freshSlackThread();
    const slackKey = slackRunKey(channelId, rootTs);
    await createOrGetRun(env.DB, {
      key: slackKey,
      origin: "slack",
      channelId,
      threadTs: rootTs,
    });

    const chatAgent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, chat.key);
    await chatAgent.addMessages([userMessage("chat side")]);

    const slackAgent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, slackKey);
    await slackAgent.addMessages([userMessage("slack side")]);

    // Addressed again from scratch, exactly as a second request would.
    const chatAgain = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, chat.key);
    const slackAgain = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, slackKey);

    expect(textsOf(await messagesOf(chatAgain))).toEqual(["chat side"]);
    // The load-bearing half: the two keys must NOT collide. A chat run reading
    // "slack side" here would be one customer's thread inside another's run.
    expect(textsOf(await messagesOf(slackAgain))).toEqual(["slack side"]);
  });

  it("gives a root Slack message and its thread reply one session, through wakeRun", async () => {
    const think: Env = { ...env, RUN_CHASSIS: "think" };
    const { channelId, rootTs } = freshSlackThread();

    // The root message: no `thread_ts`, so its own `ts` IS the thread. The
    // reply carries `thread_ts = rootTs` and a `ts` of its own. Canonicalising
    // is the ONLY thing that keeps them together — a wake that keyed on the
    // reply's own `ts` would open a second run answering the same thread.
    const rootKey = slackRunKey(channelId, canonicalThreadTs(rootTs, null));
    const replyTs = `${Math.floor(Date.now() / 1000) + 30}.654321`;
    const replyKey = slackRunKey(channelId, canonicalThreadTs(replyTs, rootTs));
    expect(replyKey).toBe(rootKey);

    const first = await wakeRun(think, rootKey, "the checkout is timing out", {
      idempotencyKey: `Ev${crypto.randomUUID()}`,
    });
    const second = await wakeRun(think, replyKey, "still happening", {
      idempotencyKey: `Ev${crypto.randomUUID()}`,
    });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    // Both submissions are in ONE session's durable ledger. Read from inside
    // the object rather than over RPC, because `listSubmissions` is a Think
    // method whose optional fields do not survive the stub's type mapping.
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, rootKey);
    const submissions = await runInDurableObject(agent, async (instance: RunAgent) =>
      (await instance.listSubmissions({ limit: 50 })).map((s) => s.submissionId),
    );
    expect(new Set(submissions).size).toBe(2);

    // ...and exactly one D1 row exists for the thread, so the dashboard and the
    // write guard see one run rather than two halves of one conversation.
    const rows = await env.DB.prepare(
      `SELECT count(*) AS n FROM runs WHERE channel_id = ? AND thread_ts = ?`,
    )
      .bind(channelId, rootTs)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

/* ----------------------------------------------------------- rpc surface -- */

describe("RunAgent rpc surface", () => {
  it("returns structured-clone-safe values across the RPC boundary", async () => {
    const agent = await agentFor();
    await agent.addMessages([userMessage("look at the logs")]);
    const { approvalId } = await agent.escalate({
      draft: "We rolled the migration back.",
      why: "closes the thread",
    });

    const messages = await messagesOf(agent);
    const approvals = await agent.pendingApprovalsForRun({ includeResolved: true });

    // `undefined`, a Date, a class instance or a function anywhere in these
    // shapes crosses the DO boundary as something the dashboard cannot render —
    // and the RPC layer either drops it silently or throws at the caller, never
    // at the author. A JSON round trip is what catches the drop.
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages);
    expect(JSON.parse(JSON.stringify(approvals))).toEqual(approvals);
    expect(approvals.map((a) => a.id)).toContain(approvalId);
    expect(textsOf(messages)).toEqual(["look at the logs"]);
  });

  it("keeps the constructor free of timers and outbound sockets", async () => {
    // The constructor's `blockConcurrencyWhile` primes the model composer and
    // resolves the run's D1 facts, and does NOTHING else: a run with no work
    // must not hold itself open, or every idle incident thread costs an alarm a
    // minute forever. This RPC is also the proof the block SETTLED — a rejected
    // `blockConcurrencyWhile` discards the object and this call would throw.
    const agent = await agentFor();
    expect(await agent.toolNames()).toEqual(["run_code"]);

    const alarm = await runInDurableObject(agent, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it("has no in-memory state to lose when the object is evicted", async () => {
    const { key } = await chatRunFor();
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    await agent.addMessages([userMessage("first")]);
    const { approvalId } = await agent.escalate({ draft: "draft", why: "closes the thread" });

    // Destroys the instance. Anything held only in memory is gone; the
    // re-addressed object re-runs the constructor and re-hydrates from SQLite.
    await evictDurableObject(agent);
    const revived = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

    expect(textsOf(await messagesOf(revived))).toEqual(["first"]);
    expect((await revived.pendingApprovalsForRun()).map((a) => a.id)).toEqual([approvalId]);

    // And it still accepts new work, which is the half a "durability" test that
    // only reads would miss.
    await revived.addMessages([userMessage("second")]);
    expect(textsOf(await messagesOf(revived))).toEqual(["first", "second"]);
  });
});

/* ------------------------------------------------------------ projection -- */

/**
 * D1 `runs` is a PROJECTION of the agent's own SQLite on this chassis too — the
 * legacy contract `test/run-do.test.ts` § "d1 index is kept in step" pins for
 * `RunDO`. `projectForTest` is `onStepFinish`'s own call, one layer down.
 */
describe("RunAgent D1 projection", () => {
  it("applies a projection only when projection_seq increases", async () => {
    const { key } = await chatRunFor();
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    const seq = Date.now();

    await agent.projectForTest({ seq, status: "live", summary: "rolling the migration back" });
    const applied = await getRunByKey(env.DB, key);
    expect(applied?.status).toBe("live");
    expect(applied?.summary).toBe("rolling the migration back");

    // A redelivered alarm carrying an OLDER revision. Invariant 32: it must
    // change nothing. Out-of-order delivery is normal, and the failure it would
    // otherwise cause is a dashboard that walks backwards mid-incident.
    await agent.projectForTest({ seq: seq - 60_000, status: "failed", summary: "stale" });

    const after = await getRunByKey(env.DB, key);
    expect(after?.status).toBe("live");
    expect(after?.summary).toBe("rolling the migration back");

    // The stale revision is still DURABLE locally — the agent's SQLite is the
    // record, and a dropped D1 write is not a dropped step.
    const local = await runInDurableObject(agent, (instance: RunAgent) =>
      instance.sql<{ seq: number; d1_applied: number }>`
        SELECT seq, d1_applied FROM run_projection_steps WHERE seq = ${seq - 60_000}
      `.map((row) => ({ seq: row.seq, applied: row.d1_applied })),
    );
    expect(local).toEqual([{ seq: seq - 60_000, applied: 0 }]);
  });

  it("moves the run index's updated_at after a committed turn", async () => {
    const { key, runId } = await chatRunFor();
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

    // Backdated first, because `createOrGetRun` and the projection can land in
    // the SAME millisecond and `updated_at` uses MAX() — without this the test
    // would be a coin flip rather than an assertion.
    await env.DB.prepare("UPDATE runs SET updated_at = updated_at - 60000 WHERE id = ?")
      .bind(runId)
      .run();
    const before = await getRunByKey(env.DB, key);

    await agent.projectForTest({ seq: Date.now(), status: "live" });

    const after = await getRunByKey(env.DB, key);
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
    // Recency moved, and the summary the dashboard was already showing did not
    // get erased by a projection that carried none.
    expect(after!.summary).toBe(before!.summary);
  });

  /**
   * KNOWN GAP — see TEST-FINDINGS.md. `RunDO.setStatus` runs every change
   * through `evaluateTransition` (src/run/protocol.ts) and refuses an illegal
   * one; the Think chassis writes status through `projectTurn` →
   * `projectRunIndex`, which validates the SEQUENCE and nothing else. So a
   * projection can walk a run from `done` back to `idle` — a released Slack
   * thread silently reclaimed by `findOwnedSlackRun`, since `idle` is an ACTIVE
   * status and `done` is not. Marked `it.fails` rather than fixed: the drill
   * terminal owns `src/`.
   */
  it.fails("refuses an illegal status transition without changing the projected state", async () => {
    const { key } = await chatRunFor();
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    const seq = Date.now();

    await agent.projectForTest({ seq, status: "live" });
    await agent.projectForTest({ seq: seq + 1, status: "done" });
    expect((await getRunByKey(env.DB, key))?.status).toBe("done");

    // `done -> idle` is not in the transition table. `done` releases the thread
    // back to triage; `idle` says the run still owns it.
    await agent.projectForTest({ seq: seq + 2, status: "idle" });
    expect((await getRunByKey(env.DB, key))?.status).toBe("done");

    // The other half: a same-state projection is legal and simply changes
    // nothing observable. This part passes today.
    await agent.projectForTest({ seq: seq + 3, status: "done" });
    expect((await getRunByKey(env.DB, key))?.status).toBe("done");
  });

  it("keeps the step durable and the projection pending when D1 is unreachable", async () => {
    const { key } = await chatRunFor();
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);
    const seq = Date.now();

    // A REAL outage, not a missing row: a missing row only makes
    // `projectRunIndex` return `applied: false`, which never throws, so it
    // could not tell the invariant from a tolerated no-op.
    const throwing = {
      prepare() {
        throw new Error("d1 is unreachable");
      },
    } as unknown as D1Database;

    const local = await runInDurableObject(agent, async (instance: RunAgent) => {
      const patched = instance as unknown as { env: Env };
      const original = patched.env;
      patched.env = { ...original, DB: throwing };
      try {
        // Must RESOLVE. A throw here comes back through `onStepFinish` into
        // Think's turn, whose recovery is another BILLED model call — so a D1
        // outage would cost money rather than a stale dashboard row.
        await instance.projectForTest({ seq, status: "live", summary: "mid-incident" });
      } finally {
        patched.env = original;
      }
      return instance.sql<{ status: string; summary: string; d1_applied: number }>`
        SELECT status, summary, d1_applied FROM run_projection_steps WHERE seq = ${seq}
      `.map((row) => ({ status: row.status, summary: row.summary, applied: row.d1_applied }));
    });

    // The step is durable where the system of record is...
    expect(local).toEqual([{ status: "live", summary: "mid-incident", applied: 0 }]);
    // ...and `d1_applied = 0` is the standing debt a later drain settles. D1
    // itself never saw the revision.
    const projected = await getRunByKey(env.DB, key);
    expect(projected?.status).toBe("idle");
    expect(projected?.summary).toBeNull();
  });
});
