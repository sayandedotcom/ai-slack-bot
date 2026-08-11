import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_STATUSES,
  RUN_STATUSES,
  evaluateTransition,
  isRunStatus,
  parseClientMessage,
  STEER_MAX_CONTENT,
  type RunStatus,
} from "../src/run/protocol";
import {
  canonicalThreadTs,
  chatRunKey,
  runStubForKey,
  slackRunKey,
} from "../src/run/keys";

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

  it.each(RUN_STATUSES)("treats %s -> itself as idempotent and eventless", (status) => {
    expect(evaluateTransition(status, status)).toEqual({ ok: true, changed: false });
  });

  it("rejects an unknown target without throwing", () => {
    const result = evaluateTransition("live", "archived" as RunStatus);
    expect(result.ok).toBe(false);
  });
});

describe("slack run keys", () => {
  it("builds the documented shape", () => {
    expect(slackRunKey("C123", "1720000000.123456")).toBe(
      "slack:C123:1720000000.123456",
    );
  });

  it("canonicalises a root message to its own ts", () => {
    // A root message has thread_ts = null; its ts IS the thread.
    expect(canonicalThreadTs("1720000000.123456", null)).toBe("1720000000.123456");
  });

  it("canonicalises a reply to the root thread_ts", () => {
    expect(canonicalThreadTs("1720000009.999999", "1720000000.123456")).toBe(
      "1720000000.123456",
    );
  });

  it("gives a root message and its reply the same key", () => {
    const root = slackRunKey("C123", canonicalThreadTs("1720000000.123456", null));
    const reply = slackRunKey(
      "C123",
      canonicalThreadTs("1720000009.999999", "1720000000.123456"),
    );
    expect(reply).toBe(root);
  });

  it("does not collide across threads in one channel", () => {
    expect(slackRunKey("C123", "1720000000.123456")).not.toBe(
      slackRunKey("C123", "1720000001.123456"),
    );
  });

  it("does not collide across channels on one thread ts", () => {
    expect(slackRunKey("C123", "1720000000.123456")).not.toBe(
      slackRunKey("C999", "1720000000.123456"),
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
    expect(slackRunKey("C123", "1720000000.123456").startsWith("slack:")).toBe(true);
  });

  it.each(["", "not-a-uuid", "3f2504e0-4f89-11d3-9a0c", `chat:${uuid}`, "3f2504e04f8911d39a0c0305e82c3301"])(
    "rejects %j",
    (bad) => {
      expect(() => chatRunKey(bad)).toThrow();
    },
  );
});

describe("runStubForKey", () => {
  function fakeNamespace() {
    const names: string[] = [];
    const namespace = {
      idFromName(name: string) {
        names.push(name);
        return { name } as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        return { id } as unknown as DurableObjectStub;
      },
    };
    return { namespace, names };
  }

  it("routes a slack key through idFromName verbatim", () => {
    const { namespace, names } = fakeNamespace();
    const key = slackRunKey("C123", "1720000000.123456");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runStubForKey(namespace as any, key);
    expect(names).toEqual(["slack:C123:1720000000.123456"]);
  });

  it("routes a chat key through the same helper", () => {
    const { namespace, names } = fakeNamespace();
    const key = chatRunKey("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runStubForKey(namespace as any, key);
    expect(names).toEqual(["chat:3f2504e0-4f89-11d3-9a0c-0305e82c3301"]);
  });

  it("refuses a malformed key rather than naming a junk object", () => {
    const { namespace, names } = fakeNamespace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => runStubForKey(namespace as any, "slack:C123")).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => runStubForKey(namespace as any, "wat:nope")).toThrow();
    expect(names).toEqual([]);
  });
});

describe("client message parser", () => {
  function steer(payload: unknown) {
    return parseClientMessage(JSON.stringify(payload));
  }

  it("accepts a well-formed steer", () => {
    const result = steer({ type: "steer", requestId: "r-1", content: "try the other branch" });
    expect(result).toEqual({
      ok: true,
      message: { type: "steer", requestId: "r-1", content: "try the other branch" },
    });
  });

  it("trims surrounding whitespace but keeps the body", () => {
    const result = steer({ type: "steer", requestId: "r-1", content: "  hello  " });
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
    const result = steer({ type: "steer", requestId: "r-1", content: "x", role: "assistant" });
    expect(result.ok).toBe(false);
  });

  it("refuses a client-supplied source", () => {
    const result = steer({ type: "steer", requestId: "r-1", content: "x", source: "approval" });
    expect(result.ok).toBe(false);
  });

  it("refuses a client-supplied id or seq", () => {
    expect(steer({ type: "steer", requestId: "r-1", content: "x", id: "triage:evil" }).ok).toBe(false);
    expect(steer({ type: "steer", requestId: "r-1", content: "x", seq: 99 }).ok).toBe(false);
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
