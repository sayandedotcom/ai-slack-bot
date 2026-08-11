import { afterEach, describe, expect, it, vi } from "vitest";
import { getPermalink } from "../src/slack/client";

// vitest-pool-workers v0.21 removed `fetchMock` from "cloudflare:test". The
// documented replacement is mocking globalThis.fetch directly.
// https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSlack(handler: (req: Request) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    if (new URL(request.url).origin !== "https://slack.com") {
      throw new Error(`Unexpected request: ${request.url}`);
    }
    return handler(request);
  });
}

describe("getPermalink", () => {
  it("returns the permalink Slack gives us", async () => {
    mockSlack(() =>
      Response.json({ ok: true, permalink: "https://zellify.slack.com/archives/C1/p1700000000000100" }),
    );

    await expect(getPermalink("xoxb-test", "C1", "1700000000.000100")).resolves.toBe(
      "https://zellify.slack.com/archives/C1/p1700000000000100",
    );
  });

  it("sends the bot token and the message coordinates", async () => {
    let seen: Request | undefined;
    mockSlack((req) => {
      seen = req;
      return Response.json({ ok: true, permalink: "https://x/y" });
    });

    await getPermalink("xoxb-test", "C1", "1700000000.000100");

    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/api/chat.getPermalink");
    expect(url.searchParams.get("channel")).toBe("C1");
    expect(url.searchParams.get("message_ts")).toBe("1700000000.000100");
    expect(seen!.headers.get("authorization")).toBe("Bearer xoxb-test");
  });

  it("returns null when Slack reports an error rather than throwing", async () => {
    mockSlack(() => Response.json({ ok: false, error: "message_not_found" }));
    await expect(getPermalink("xoxb-test", "C1", "1.1")).resolves.toBeNull();
  });

  it("returns null on a transport failure rather than throwing", async () => {
    mockSlack(() => new Response("boom", { status: 500 }));
    await expect(getPermalink("xoxb-test", "C1", "1.1")).resolves.toBeNull();
  });

  it("returns null when fetch itself throws", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(getPermalink("xoxb-test", "C1", "1.1")).resolves.toBeNull();
  });
});
