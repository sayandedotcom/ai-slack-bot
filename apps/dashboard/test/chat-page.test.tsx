/**
 * The chat page: the create form and its idempotency.
 *
 * Same harness note as `run-view.test.tsx` — no DOM, so the page is pure and
 * the network half (`makeChatStarter`) is a plain function.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeChatStarter,
  type StartedRun,
  startChatRun,
} from "../src/chat/api";
import { ChatPage, type ChatPageProps } from "../src/chat/chat-page";

function page(over: Partial<ChatPageProps> = {}): string {
  const props: ChatPageProps = {
    starting: false,
    error: null,
    onStart: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(ChatPage, props));
}

function stubFetch(
  impl: (input: string, init?: RequestInit) => Promise<Response> | Response
) {
  const spy = vi.fn((input: unknown, init?: unknown) =>
    impl(String(input), init as RequestInit)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("the create form", () => {
  it("cannot be submitted empty", () => {
    expect(page()).toContain("disabled");
  });

  it("locks while a create is in flight, so a second Enter is not a second run", () => {
    const html = page({ starting: true });
    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });

  it("says what failed without claiming the run exists", () => {
    const html = page({ error: "Could not start that run. Try again." });
    expect(html).toContain("Could not start that run. Try again.");
    expect(html).not.toContain("Starting…");
  });

  it("tells the reader a chat run is the same kind of run, and still gated", () => {
    const html = page();
    expect(html).toContain("the same kind of run");
    expect(html).toContain("everything committal still needs a human");
  });
});

describe("starting a run", () => {
  it("posts the message and the client id, and answers with the public id", async () => {
    const fetchSpy = stubFetch(
      () =>
        new Response(JSON.stringify({ id: "run-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );

    const run = await startChatRun("why is the exporter stuck?", "req-1");
    expect(run).toEqual({ id: "run-1" });

    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      firstMessage: "why is the exporter stuck?",
      clientRequestId: "req-1",
    });
  });

  it("creates once when the same question is submitted twice before it lands", async () => {
    const post = vi.fn<(text: string, id: string) => Promise<StartedRun>>(
      async () => ({
        id: "run-1",
      })
    );
    const starter = makeChatStarter(post, () => "req-1");

    const [a, b] = await Promise.all([
      starter.start("same"),
      starter.start("same"),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ id: "run-1" });
    expect(b).toEqual({ id: "run-1" });
  });

  it("REUSES the client id on a retry, so a retried create is not a second run", async () => {
    // The opposite of a steer's rule, and deliberately: a create that failed
    // may already have written a run, so re-asserting it has to carry the same
    // id or the human ends up with two conversations for one question.
    const post = vi
      .fn<(text: string, id: string) => Promise<StartedRun>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ id: "run-1" });
    let n = 0;
    const starter = makeChatStarter(post, () => `req-${++n}`);

    await expect(starter.start("same")).rejects.toThrow();
    await starter.start("same");

    expect(post.mock.calls.map((call) => call[1])).toEqual(["req-1", "req-1"]);
  });

  it("mints a different id for a different question", async () => {
    const post = vi.fn<(text: string, id: string) => Promise<StartedRun>>(
      async () => ({
        id: "run-1",
      })
    );
    let n = 0;
    const starter = makeChatStarter(post, () => `req-${++n}`);

    await starter.start("first");
    await starter.start("second");

    expect(post.mock.calls.map((call) => call[1])).toEqual(["req-1", "req-2"]);
  });

  it("posts nothing for whitespace", async () => {
    const post = vi.fn<(text: string, id: string) => Promise<StartedRun>>();
    expect(await makeChatStarter(post).start("   ")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("names the path and nothing else when the create is refused", async () => {
    // Response bodies can hold stack traces and hostnames; they never reach an
    // Error that might end up in a log or a screenshot.
    stubFetch(() => new Response("nope: secret-token-inside", { status: 403 }));
    await expect(startChatRun("hello", "req-1")).rejects.toThrow(
      /\/api\/runs failed \(403\)/
    );
    await expect(startChatRun("hello", "req-1")).rejects.not.toThrow(
      /secret-token-inside/
    );
  });
});
