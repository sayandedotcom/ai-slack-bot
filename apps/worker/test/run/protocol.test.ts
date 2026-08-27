import { describe, expect, it } from "vitest";
import { canonicalThreadTs, chatRunKey, slackRunKey } from "../../src/run/keys";
import {
  ACTIVE_RUN_STATUSES,
  ASSISTANT_DELTA_MAX,
  ASSISTANT_ERROR_MAX,
  ASSISTANT_FLUSH_CHARS,
  ASSISTANT_FLUSH_MS,
  ASSISTANT_UPDATE_STATES,
  type AssistantUpdate,
  evaluateTransition,
  isAssistantUpdateState,
  isRunStatus,
  parseClientMessage,
  RUN_STATUSES,
  type RunEvent,
  type RunStatus,
  STEER_MAX_CONTENT,
} from "../../src/run/protocol";

describe("run statuses", () => {
  it("is exactly the five documented statuses, in order", () => {
    expect(RUN_STATUSES).toEqual([
      "live",
      "awaiting_approval",
      "idle",
      "done",
      "failed",
    ]);
  });

  it("exposes the active subset the repository queries by", () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(["live", "awaiting_approval", "idle"]);
  });

  it("rejects anything outside the list", () => {
    expect(isRunStatus("live")).toBe(true);
    expect(isRunStatus("running")).toBe(false);
    expect(isRunStatus("")).toBe(false);
    expect(isRunStatus("LIVE")).toBe(false);
    // The banned pipeline would arrive as a status before it arrived as a column.
    expect(isRunStatus("bug")).toBe(false);
  });
});

describe("status transitions", () => {
  const allowed: Array<[RunStatus, RunStatus]> = [
    ["live", "awaiting_approval"],
    ["live", "idle"],
    ["live", "done"],
    ["live", "failed"],
    ["awaiting_approval", "live"],
    ["awaiting_approval", "idle"],
    ["awaiting_approval", "done"],
    ["awaiting_approval", "failed"],
    ["idle", "live"],
    ["idle", "done"],
    ["idle", "failed"],
    ["done", "live"],
    ["failed", "live"],
  ];

  it.each(allowed)("allows %s -> %s and counts it as a change", (from, to) => {
    expect(evaluateTransition(from, to)).toEqual({ ok: true, changed: true });
  });

  it("reopens a finished thread, because the thread owns one session", () => {
    // The whole reason done/failed are not terminal: a new actionable message
    // in the same Slack thread must regain its history, not fork a second DO.
    expect(evaluateTransition("done", "live").ok).toBe(true);
    expect(evaluateTransition("failed", "live").ok).toBe(true);
  });

  const forbidden: Array<[RunStatus, RunStatus]> = [
    ["idle", "awaiting_approval"],
    ["done", "idle"],
    ["done", "awaiting_approval"],
    ["done", "failed"],
    ["failed", "done"],
    ["failed", "idle"],
    ["failed", "awaiting_approval"],
  ];

  it.each(forbidden)("forbids %s -> %s", (from, to) => {
    const result = evaluateTransition(from, to);
    expect(result.ok).toBe(false);
  });

  it.each(RUN_STATUSES)(
    "treats %s -> itself as idempotent and eventless",
    (status) => {
      expect(evaluateTransition(status, status)).toEqual({
        ok: true,
        changed: false,
      });
    }
  );

  it("rejects an unknown target without throwing", () => {
    const result = evaluateTransition("live", "archived" as RunStatus);
    expect(result.ok).toBe(false);
  });
});

describe("slack run keys", () => {
  it("builds the documented shape", () => {
    expect(slackRunKey("C123", "1720000000.123456")).toBe(
      "slack:C123:1720000000.123456"
    );
  });

  it("canonicalises a root message to its own ts", () => {
    // A root message has thread_ts = null; its ts IS the thread.
    expect(canonicalThreadTs("1720000000.123456", null)).toBe(
      "1720000000.123456"
    );
  });

  it("canonicalises a reply to the root thread_ts", () => {
    expect(canonicalThreadTs("1720000009.999999", "1720000000.123456")).toBe(
      "1720000000.123456"
    );
  });

  it("gives a root message and its reply the same key", () => {
    const root = slackRunKey(
      "C123",
      canonicalThreadTs("1720000000.123456", null)
    );
    const reply = slackRunKey(
      "C123",
      canonicalThreadTs("1720000009.999999", "1720000000.123456")
    );
    expect(reply).toBe(root);
  });

  it("does not collide across threads in one channel", () => {
    expect(slackRunKey("C123", "1720000000.123456")).not.toBe(
      slackRunKey("C123", "1720000001.123456")
    );
  });

  it("does not collide across channels on one thread ts", () => {
    expect(slackRunKey("C123", "1720000000.123456")).not.toBe(
      slackRunKey("C999", "1720000000.123456")
    );
  });

  it.each([
    ["", "1720000000.123456"],
    ["C123", ""],
    // A colon in a component would let one thread forge another thread's key.
    ["C1:23", "1720000000.123456"],
    ["C123", "1720000000:123456"],
    ["c123", "1720000000.123456"],
    ["C123", "1720000000"],
    ["C123", "not-a-timestamp"],
    ["C123", "1720000000.12345"],
  ])("rejects channel %j / ts %j before idFromName", (channelId, threadTs) => {
    expect(() => slackRunKey(channelId, threadTs)).toThrow();
  });
});

describe("chat run keys", () => {
  const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("builds the documented shape", () => {
    expect(chatRunKey(uuid)).toBe(`chat:${uuid}`);
  });

  it("cannot collide with a slack key", () => {
    expect(chatRunKey(uuid).startsWith("chat:")).toBe(true);
    expect(slackRunKey("C123", "1720000000.123456").startsWith("slack:")).toBe(
      true
    );
  });

  it.each([
    "",
    "not-a-uuid",
    "3f2504e0-4f89-11d3-9a0c",
    `chat:${uuid}`,
    "3f2504e04f8911d39a0c0305e82c3301",
  ])("rejects %j", (bad) => {
    expect(() => chatRunKey(bad)).toThrow();
  });
});

// The `runStubForKey` cases lived here. It was the codebase's only
// `idFromName()` call — the seam that turned a validated run key into the
// Durable Object that owned the session — and it went with the agent layer on
// 2026-08-23. The property is worth restoring against whatever names the new
// session: a malformed or unknown-origin key must THROW rather than conjure an
// anonymous object, and the public `runs.id` must never be the name.

describe("client message parser", () => {
  function steer(payload: unknown) {
    return parseClientMessage(JSON.stringify(payload));
  }

  it("accepts a well-formed steer", () => {
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "try the other branch",
    });
    expect(result).toEqual({
      ok: true,
      message: {
        type: "steer",
        requestId: "r-1",
        content: "try the other branch",
      },
    });
  });

  it("trims surrounding whitespace but keeps the body", () => {
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "  hello  ",
    });
    expect(result.ok && result.message.content).toBe("hello");
  });

  it("rejects binary frames", () => {
    const result = parseClientMessage(new ArrayBuffer(8));
    expect(result.ok).toBe(false);
  });

  it("rejects invalid json", () => {
    const result = parseClientMessage("{not json");
    expect(result.ok).toBe(false);
  });

  it.each([
    [{ type: "ping" }],
    [{ type: "append_turn", requestId: "r", content: "x" }],
    [{ requestId: "r", content: "x" }],
    [{ type: "steer", content: "x" }],
    [{ type: "steer", requestId: "r" }],
    [{ type: "steer", requestId: "", content: "x" }],
    [{ type: "steer", requestId: "r", content: "" }],
    [{ type: "steer", requestId: "r", content: "   " }],
    [{ type: "steer", requestId: 7, content: "x" }],
    [{ type: "steer", requestId: "r", content: 7 }],
    ["a bare string"],
    [null],
    [[]],
  ])("rejects %j", (payload) => {
    expect(steer(payload).ok).toBe(false);
  });

  it("rejects oversized content instead of committing it", () => {
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "x".repeat(STEER_MAX_CONTENT + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts content exactly at the limit", () => {
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "x".repeat(STEER_MAX_CONTENT),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a client-supplied role", () => {
    // The server assigns role/source. A browser must not be able to claim it is
    // the customer or an approval decision.
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "x",
      role: "assistant",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a client-supplied source", () => {
    const result = steer({
      type: "steer",
      requestId: "r-1",
      content: "x",
      source: "approval",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a client-supplied id or seq", () => {
    expect(
      steer({
        type: "steer",
        requestId: "r-1",
        content: "x",
        id: "triage:evil",
      }).ok
    ).toBe(false);
    expect(
      steer({ type: "steer", requestId: "r-1", content: "x", seq: 99 }).ok
    ).toBe(false);
  });

  it("returns a stable machine-readable code on every rejection", () => {
    const result = parseClientMessage("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.code).toBe("string");
      expect(result.code.length).toBeGreaterThan(0);
    }
  });
});

describe("assistant updates", () => {
  it("is exactly the six documented states, in order", () => {
    expect(ASSISTANT_UPDATE_STATES).toEqual([
      "started",
      "streaming",
      "completed",
      "superseded",
      "aborted",
      "failed",
    ]);
    expect(isAssistantUpdateState("streaming")).toBe(true);
    expect(isAssistantUpdateState("thinking")).toBe(false);
    expect(isAssistantUpdateState("")).toBe(false);
  });

  it("keeps the batch thresholds below the hard caps", () => {
    // The thresholds are the intent — flush at 250ms or 512 characters. The
    // caps are the defence against a caller that batched badly, or an error
    // string carrying a whole provider body into the replay log.
    expect(ASSISTANT_FLUSH_CHARS).toBe(512);
    expect(ASSISTANT_FLUSH_MS).toBe(250);
    expect(ASSISTANT_DELTA_MAX).toBeGreaterThan(ASSISTANT_FLUSH_CHARS);
    expect(ASSISTANT_ERROR_MAX).toBeLessThan(ASSISTANT_DELTA_MAX);
  });

  it("round-trips every state as a finite, rpc-serializable event", () => {
    for (const state of ASSISTANT_UPDATE_STATES) {
      const update: AssistantUpdate = {
        id: "assistant:gen:abc:0:1",
        generationId: "gen:abc",
        attempt: 0,
        state,
        ...(state === "streaming" ? { delta: "partial answer" } : {}),
        ...(state === "failed" ? { error: "provider_unavailable" } : {}),
        createdAt: 1_700_000_000_000,
      };
      const event: RunEvent = { seq: 7, type: "assistant_update", update };

      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      // Finite: no cycle, no undefined, nothing that turns into a huge frame.
      expect(JSON.stringify(event).length).toBeLessThan(1_000);
    }
  });

  it("carries no reasoning, thinking, provider body or metadata field", () => {
    const update: AssistantUpdate = {
      id: "assistant:gen:abc:0:0",
      generationId: "gen:abc",
      attempt: 0,
      state: "streaming",
      delta: "hello",
      createdAt: 1,
    };
    // The shape is closed. Anything a provider chunk carries has nowhere to go.
    expect(Object.keys(update).sort()).toEqual(
      ["attempt", "createdAt", "delta", "generationId", "id", "state"].sort()
    );
    for (const banned of [
      "reasoning",
      "thinking",
      "signature",
      "raw",
      "metadata",
      "providerBody",
    ]) {
      expect(banned in update).toBe(false);
    }
  });

  it("shares the one seq cursor with turns, tool calls and statuses", () => {
    // Structural: an assistant update IS a RunEvent, so reconnect replays it
    // through the existing `since` cursor rather than a second protocol.
    const events: RunEvent[] = [
      {
        seq: 1,
        type: "status",
        previousStatus: "idle",
        status: "live",
        createdAt: 1,
      },
      {
        seq: 2,
        type: "assistant_update",
        update: {
          id: "assistant:gen:abc:0:0",
          generationId: "gen:abc",
          attempt: 0,
          state: "started",
          createdAt: 2,
        },
      },
    ];
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("cannot be injected by a browser frame", () => {
    // The client protocol has exactly one message type. A tab cannot author a
    // server-owned event by naming it.
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "assistant_update",
          requestId: "r-1",
          content: "hi",
        })
      )
    ).toMatchObject({ ok: false, code: "unknown_type" });

    // Nor by smuggling the server-owned identity fields onto a legal steer.
    for (const field of [
      "id",
      "seq",
      "createdAt",
      "metadata",
      "role",
      "source",
    ]) {
      expect(
        parseClientMessage(
          JSON.stringify({
            type: "steer",
            requestId: "r-1",
            content: "hi",
            [field]: "x",
          })
        )
      ).toMatchObject({ ok: false, code: "server_owned_field" });
    }
  });
});
