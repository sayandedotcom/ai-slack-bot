import { describe, expect, it, vi } from "vitest";

import { makeChatStarter } from "@/lib/api/chat";
import { agentBasePath, makeSteerSender } from "@/lib/hooks/use-run-agent";

/**
 * The two request-id rules, which are OPPOSITES and are the whole reason both
 * of these helpers exist as pure functions rather than as inline code in a
 * component.
 *
 * A create that failed may have arrived and written a run, so a retry must
 * carry the SAME id or the human ends up with two conversations for one
 * question. A steer that failed may never have arrived, so a retry must carry a
 * FRESH id or the agent refuses it as a duplicate of something that never
 * happened.
 */

function mintCounter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("makeChatStarter", () => {
  it("reuses one clientRequestId when the same text is retried after a failure", async () => {
    const seen: string[] = [];
    const post = vi
      .fn()
      .mockImplementationOnce((_text: string, id: string) => {
        seen.push(id);
        return Promise.reject(new Error("network"));
      })
      .mockImplementationOnce((_text: string, id: string) => {
        seen.push(id);
        return Promise.resolve({ id: "run-1" });
      });

    const starter = makeChatStarter(post, mintCounter());

    await expect(starter.start("why is checkout broken?")).rejects.toThrow();
    await expect(starter.start("why is checkout broken?")).resolves.toEqual({
      id: "run-1",
    });

    expect(seen).toEqual(["id-1", "id-1"]);
  });

  it("joins the attempt already in flight for the same text", async () => {
    const post = vi.fn(() => Promise.resolve({ id: "run-1" }));
    const starter = makeChatStarter(post, mintCounter());

    const [a, b] = await Promise.all([
      starter.start("same"),
      starter.start("same"),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("gives two different texts two different ids", async () => {
    const seen: string[] = [];
    const post = vi.fn((_text: string, id: string) => {
      seen.push(id);
      return Promise.resolve({ id: "run" });
    });
    const starter = makeChatStarter(post, mintCounter());

    await starter.start("first");
    await starter.start("second");

    expect(seen).toEqual(["id-1", "id-2"]);
  });

  it("refuses an empty submission without opening a request", async () => {
    const post = vi.fn(() => Promise.resolve({ id: "run" }));
    await expect(makeChatStarter(post).start("   ")).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("makeSteerSender", () => {
  it("mints a FRESH id when the same text is retried after a failure", async () => {
    const seen: string[] = [];
    const send = vi
      .fn()
      .mockImplementationOnce((_text: string, id: string) => {
        seen.push(id);
        return Promise.reject(new Error("socket"));
      })
      .mockImplementationOnce((_text: string, id: string) => {
        seen.push(id);
        return Promise.resolve(undefined);
      });

    const sender = makeSteerSender(send, mintCounter());

    await expect(sender.submit("stop and check the trace")).rejects.toThrow();
    await sender.submit("stop and check the trace");

    expect(seen).toEqual(["id-1", "id-2"]);
  });

  it("collapses a double-click into one steer", async () => {
    const send = vi.fn(() => Promise.resolve(undefined));
    const sender = makeSteerSender(send, mintCounter());

    await Promise.all([sender.submit("wait"), sender.submit("wait")]);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("agentBasePath", () => {
  it("addresses the public run id under /api, with no leading slash", () => {
    expect(agentBasePath("5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3")).toBe(
      "api/runs/5f3b1c22-9d41-4a7e-8b02-1d6c4f0a91e3/agent"
    );
  });

  it("encodes anything that is not a plain id, so a key can never shape a path", () => {
    expect(agentBasePath("slack:C123:1787.0001")).toBe(
      "api/runs/slack%3AC123%3A1787.0001/agent"
    );
  });
});
