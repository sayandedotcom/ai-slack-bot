import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it } from "vitest";

import { makeRunAgentResolutionNotifier } from "../src/approval/notifier";
import { decideApproval, listOpen } from "../src/approval/repository";
import { slackRunKey } from "../src/run/keys";
import { installTestModel, resetTestModel } from "../src/run/model";
import { getRunByKey } from "../src/run/repository";
import { wakeRun } from "../src/run/wake";
import { toolCallingModel } from "./helpers/canned-model";
import { waitFor } from "./helpers/wait";

/**
 * INVARIANT 39, swept rather than asserted: no configured credential reaches a
 * prompt, an event, a tool output, a log, a durable row or memory.
 *
 * THE CANARIES ARE THE POOL'S OWN BINDINGS, not planted fictions, and that is
 * the point. Every secret-shaped binding this Worker reads is enumerated off
 * `env` at runtime — the synthetic `not-a-real-*` fixtures AND whatever a
 * developer's `.dev.vars` supplies — so the sweep covers the credentials the
 * code actually holds, including ones added after this file was written. A
 * planted value would only prove that the planted value did not leak.
 *
 * FAILURES NAME THE BINDING, NEVER THE VALUE. The whole subject of this file is
 * that credential values do not belong in durable places, and a test report is
 * one of those places.
 *
 * THE SWEEP ENUMERATES `sqlite_master`, and never a list of table names. The
 * tables that matter are Think's — the session tree, the submission ledger, the
 * chat fiber snapshots, the cached prompt store, the stream chunk table — and
 * that set changes with the SDK. A hand-written list would keep passing after
 * the SDK added the table that leaks.
 */

/** Binding NAMES whose values are credential-shaped. Values never appear here. */
const SECRET_NAME =
  /token|secret|password|passwd|api[_-]?key|_key$|credential|_pat$|signing/i;

/** Too short to be a credential, and short strings collide with real content. */
const MIN_CANARY_CHARS = 12;

type Canary = { name: string; value: string };

/**
 * Every secret-shaped binding, as a name/value pair.
 *
 * Names that are configuration rather than credential — an endpoint, a project
 * id — are excluded by the pattern, not by a list, so a new secret is swept the
 * day it is bound.
 */
function canaries(): Canary[] {
  const out: Canary[] = [];
  for (const [name, value] of Object.entries(
    env as unknown as Record<string, unknown>
  )) {
    if (!SECRET_NAME.test(name)) continue;
    if (typeof value !== "string" || value.length < MIN_CANARY_CHARS) continue;
    out.push({ name, value });
  }
  return out;
}

/** Which canaries appear in `haystack`. Reported by NAME. */
function leaked(haystack: string, found: Canary[] = canaries()): string[] {
  return found
    .filter((canary) => haystack.includes(canary.value))
    .map((canary) => canary.name);
}

let channelSeq = 0;
async function liveChannel(): Promise<string> {
  channelSeq += 1;
  const channelId = `CCAN${channelSeq}${Math.floor(Math.random() * 1e5)}`
    .toUpperCase()
    .slice(0, 20);
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'pulsefit', 'live')"
  )
    .bind(channelId, `ext-${channelId.toLowerCase()}`)
    .run();
  return channelId;
}

let threadSeq = 1_750_000_000;
function freshThreadTs(): string {
  threadSeq += 1;
  return `${threadSeq}.000100`;
}

/** The model-authored program. A REAL capability call, through the connector. */
const PROGRAM = `
const opened = await approval.escalate({
  draft: "We found the exporter was out of memory and restarted it.",
  why: "this closes the thread and commits us to a cause",
});
return opened.approvalId;
`;

type SweepStub = {
  sweepForCanaryForTest(needle: string): Promise<string[]>;
  codemodeAuditForTest(): Promise<string>;
  runStateForTest(): Promise<{ openApprovalId: string | null }>;
};

afterEach(() => resetTestModel());

describe("the canary set", () => {
  it("finds the credentials this Worker actually holds", () => {
    // If this ever goes empty the sweep below is vacuous, so it is checked
    // rather than assumed. Names only.
    const names = canaries().map((canary) => canary.name);
    expect(names.length).toBeGreaterThan(3);
    expect(names).toContain("LINEAR_API_KEY");
    expect(names).toContain("ZEP_API_KEY");
  });

  it("catches a leak when there is one", () => {
    // The sweep's own smoke test: a detector that cannot fail proves nothing.
    const [first] = canaries();
    expect(leaked(`prefix ${first?.value ?? ""} suffix`)).toContain(
      first?.name
    );
  });
});

describe("one full run, then the sweep", () => {
  it("leaves no credential in any durable store it touched", async () => {
    installTestModel(
      toolCallingModel({ program: PROGRAM, text: "Asked a human first." })
    );

    // 1. WAKE — the D1 row, the shadow ratchet, the opening turn.
    const channelId = await liveChannel();
    const threadTs = freshThreadTs();
    await wakeRun(env, {
      eventId: `Ev${crypto.randomUUID()}`,
      channelId,
      threadTs,
      openingPrompt:
        "pulsefit says the exporter is stuck and asked us to confirm the cause",
    });

    const key = slackRunKey(channelId, threadTs);
    const run = await getRunByKey(env.DB, key);
    if (run === null) throw new Error("the wake wrote no run row");
    const stub = (await getAgentByName(
      env.RUN_AGENTS,
      key
    )) as unknown as SweepStub;

    // 2. RUN_CODE + a real capability call. The program runs in a loader
    //    isolate and calls `approval.escalate` through the connector, so the
    //    execution's code, its arguments and its result all reach the runtime's
    //    durable log.
    const card = await waitFor("the escalation", async () => {
      const open = await listOpen(env.DB, 50);
      return open.find((row) => row.runId === run.id) ?? null;
    });

    // 3. RESOLVE — a human decides, and the decision re-enters as a turn.
    await decideApproval(
      env.DB,
      card.id,
      {
        action: "edit",
        text: "The exporter ran out of memory; we have restarted it.",
      },
      "ronit@zellify.app",
      Date.now()
    );
    await makeRunAgentResolutionNotifier({ env }).notify({
      runId: run.id,
      approvalId: card.id,
      decision: "edited",
      outboundText: "The exporter ran out of memory; we have restarted it.",
      rejectReason: null,
      decidedBy: "ronit@zellify.app",
    });
    await waitFor("the run to unpark", async () => {
      const state = await stub.runStateForTest();
      return state.openApprovalId === null ? state : null;
    });

    const found = canaries();

    // --- the agent's own SQLite: Think's session tree, submissions, fibers,
    //     the cached prompt store, the stream chunks. Enumerated, not listed.
    for (const canary of found) {
      expect({
        binding: canary.name,
        tables: await stub.sweepForCanaryForTest(canary.value),
      }).toEqual({ binding: canary.name, tables: [] });
    }

    // --- Code Mode's audit trail: the model-authored program, every call's
    //     arguments, every logged result.
    expect(leaked(await stub.codemodeAuditForTest(), found)).toEqual([]);

    // --- D1, every table, enumerated the same way.
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all<{ name: string }>();

    const swept: string[] = [];
    for (const { name } of tables ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      // `_cf_METADATA` is D1's own bookkeeping and refuses SQL with
      // SQLITE_AUTH. Skipped by an explicit rule, and the assertion below is
      // what stops that rule from quietly growing to cover a table that holds
      // application data.
      if (name.startsWith("_cf_")) continue;
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      swept.push(name);
      expect({
        table: name,
        leaked: leaked(JSON.stringify(results ?? []), found),
      }).toEqual({
        table: name,
        leaked: [],
      });
    }

    // Every table this run wrote to was actually read. A sweep that skipped one
    // of these would be reporting on storage it never opened.
    expect(swept).toEqual(
      expect.arrayContaining([
        "runs",
        "approvals",
        "agent_model_calls",
        "codemode_effects",
        "agent_memory_outbox",
        "channels",
      ])
    );
  });
});

describe("what a read leaves in the durable log", () => {
  it("keeps a read's RESULT out of it, because a result is other people's data", async () => {
    // `cm_log` stores args and results verbatim for replay. A read's result is
    // the one unbounded thing in this system that is entirely made of somebody
    // else's bytes — a whole Slack thread, a page of production logs — so every
    // `read` capability is `replay: "reexecute"` and its result is never
    // stored. This pins the classification, which is what the connector reads.
    const { NAMESPACE_FACTORIES } = await import(
      "../src/capabilities/registry"
    );
    const { testBindingContext } = await import("./helpers/capabilities");
    const ctx = testBindingContext();

    const reads: string[] = [];
    const writes: string[] = [];
    for (const factory of NAMESPACE_FACTORIES) {
      for (const [method, tool] of Object.entries(factory.build(ctx))) {
        (tool.effect === "read" ? reads : writes).push(
          `${factory.name}.${method}`
        );
      }
    }
    expect(reads.length).toBeGreaterThan(10);
    expect(writes.length).toBeGreaterThan(3);
  });
});
