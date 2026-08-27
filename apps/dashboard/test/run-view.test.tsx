/**
 * The run view's four states, and the one write behind it.
 *
 * Harness note: this package has NO DOM — `vite.config.ts` is the whole vitest
 * config, there is no jsdom and no testing-library. Rendering is
 * `react-dom/server`'s `renderToStaticMarkup`, which needs no document but
 * cannot run effects. That is why `RunView` takes everything it draws as props
 * and opens no socket: the split is what makes the states assertable at all.
 * `useRunAgent` itself is exercised through its pure half, `makeSteerSender`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunView, type RunViewProps } from "../src/runs/run-view";
import {
  agentBasePath,
  makeSteerSender,
  type ChatMessage,
} from "../src/runs/use-run-agent";

function view(over: Partial<RunViewProps> = {}): string {
  const props: RunViewProps = {
    connection: "live",
    connectionError: false,
    messages: [],
    status: "idle",
    busy: false,
    turnError: false,
    sendError: null,
    onSend: () => {},
    onDismissError: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(RunView, props));
}

/** A minimal transcript message, shaped like what the socket delivers. */
function message(over: Record<string, unknown> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text: "Looked at the exporter." }],
    ...over,
  } as ChatMessage;
}

describe("the four states", () => {
  it("says it is connecting before the socket is up", () => {
    const html = view({ connection: "connecting" });
    expect(html).toContain("Connecting to the run…");
    expect(html).not.toContain("Reconnecting");
  });

  it("says it may be stale after the socket has dropped once", () => {
    // A socket that dropped and keeps showing the last transcript is lying to
    // whoever is steering an incident.
    const html = view({ connection: "reconnecting" });
    expect(html).toContain("Reconnecting — you may be seeing a stale view");
  });

  it("says nothing about the connection when it is healthy", () => {
    const html = view({ connection: "live" });
    expect(html).not.toContain("Connecting to the run");
    expect(html).not.toContain("Reconnecting");
  });

  it("names Access when the socket is refused outright", () => {
    const html = view({ connectionError: true });
    expect(html).toContain("signed out of Access");
  });

  it("shows an empty hint rather than a blank box", () => {
    const html = view({ messages: [] });
    expect(html).toContain("Nothing yet");
  });

  it("shows the turn instead of the empty hint once there is one", () => {
    const html = view({ messages: [message()] });
    expect(html).toContain("Looked at the exporter.");
    expect(html).not.toContain("Nothing yet");
  });

  it("says it is working, and does not call that empty", () => {
    const html = view({ messages: [], busy: true });
    expect(html).toContain("Working…");
    expect(html).not.toContain("Nothing yet");
  });

  it("offers a dismiss for a failed turn", () => {
    const html = view({ turnError: true });
    expect(html).toContain("The agent stopped with an error.");
    expect(html).toContain("Dismiss");
  });

  it("shows a failed send without pretending the turn failed", () => {
    const html = view({ sendError: "Could not send that. Try again." });
    expect(html).toContain("Could not send that. Try again.");
    expect(html).not.toContain("The agent stopped with an error.");
  });
});

describe("the status pill", () => {
  it("says what the run is doing, in the operator's words", () => {
    expect(view({ status: "live" })).toContain("Working");
    expect(view({ status: "awaiting_approval" })).toContain(
      "Waiting on a human"
    );
    expect(view({ status: "failed" })).toContain("Failed");
    expect(view({ status: "done" })).toContain("Closed");
  });

  it("shows nothing until the first state frame arrives", () => {
    expect(view({ status: null })).not.toContain("status-pill");
  });
});

describe("the transcript", () => {
  it("renders a run_code call as a collapsed tool row", () => {
    const html = view({
      messages: [
        message({
          parts: [
            {
              type: "tool-run_code",
              state: "output-available",
              input: { code: "await slack.thread()" },
              output: { ok: true },
            },
          ],
        }),
      ],
    });
    expect(html).toContain("run_code");
    expect(html).toContain('data-slot="tool-row"');
    // Collapsed: every capability call is inside one payload, so an expanded
    // row is most of the transcript's bytes and rarely what was come for.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("await slack.thread()");
  });

  it("does not render reasoning, because there is none to render", () => {
    // The provider returns thinking with an empty text field (invariant 17), so
    // a row would advertise a blank.
    const html = view({
      messages: [message({ parts: [{ type: "reasoning", text: "" }] })],
    });
    expect(html).not.toContain("thinking");
  });

  it("puts the approval card inside the transcript", () => {
    // A run parks mid-answer and the reader is looking at the transcript;
    // making them find the queue behind this view is how a customer waits ten
    // minutes for a reply that was already written.
    const html = view({
      status: "awaiting_approval",
      approvals: createElement("div", { "data-slot": "run-approvals" }, "card"),
    });
    expect(html).toContain('data-slot="run-approvals"');
  });
});

describe("the composer", () => {
  it("offers one verb, and it is a steer", () => {
    // Every send is a steer: the worker drops `chat-request` from every
    // connection, so a "send a message" path would fail silently.
    const html = view();
    expect(html).toContain("Steer");
    expect(html).toContain("Steer the agent");
    expect(html).not.toContain(">Send<");
  });

  it("cannot be submitted empty", () => {
    expect(view()).toContain("disabled");
  });
});

describe("sending a steer", () => {
  it("steers once when the same text is submitted twice before it lands", async () => {
    // A double-click, a held Enter, a handler that fires twice — all one thing
    // the human meant.
    const send = vi.fn(async () => undefined);
    const steer = makeSteerSender(send, () => "req-1");

    await Promise.all([steer.submit("look again"), steer.submit("look again")]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("look again", "req-1");
  });

  it("steers twice for two different things typed quickly", async () => {
    const send = vi.fn<(text: string, requestId: string) => Promise<unknown>>(
      async () => undefined
    );
    let n = 0;
    const steer = makeSteerSender(send, () => `req-${++n}`);

    await Promise.all([
      steer.submit("look again"),
      steer.submit("and check the deploy"),
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[1])).toEqual(["req-1", "req-2"]);
  });

  it("sends nothing for whitespace", async () => {
    const send = vi.fn(async () => undefined);
    await makeSteerSender(send).submit("   ");
    expect(send).not.toHaveBeenCalled();
  });

  it("trims before it dedupes, so spacing is not a second steer", async () => {
    const send = vi.fn(async () => undefined);
    const steer = makeSteerSender(send, () => "req-1");
    await Promise.all([
      steer.submit("look again"),
      steer.submit("  look again  "),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets a human re-assert after a failure they were shown", async () => {
    // A retry gets a fresh id on purpose: the first attempt may never have
    // arrived, and reusing the id would have the agent refuse it as a
    // duplicate of a steer it never took.
    let n = 0;
    const send = vi
      .fn<(text: string, requestId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const steer = makeSteerSender(send, () => `req-${++n}`);

    await expect(steer.submit("look again")).rejects.toThrow();
    await steer.submit("look again");

    expect(send.mock.calls.map((call) => call[1])).toEqual(["req-1", "req-2"]);
  });
});

describe("where the socket connects", () => {
  it("addresses the run by its public id, under the gated /api prefix", () => {
    // Relative and without a leading slash: partysocket builds
    // `${host}/${basePath}`. Under `/api` so it inherits the dashboard's own
    // Access application.
    expect(agentBasePath("11111111-2222-3333-4444-555555555555")).toBe(
      "api/runs/11111111-2222-3333-4444-555555555555/agent"
    );
  });

  it("escapes anything that is not a plain id", () => {
    expect(agentBasePath("chat:abc/../..")).toBe(
      "api/runs/chat%3Aabc%2F..%2F../agent"
    );
  });
});
