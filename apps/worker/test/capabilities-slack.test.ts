import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeSlackTools } from "../src/capabilities/namespaces/slack";
import type { SlackGateway, SlackMessage } from "../src/gateways/ports";
import {
  createOrGetRun,
  createOrGetRunUnderPolicy,
} from "../src/run/repository";
import { testBindingContext } from "./helpers/capabilities";

function messages(): SlackMessage[] {
  return [
    {
      ts: "1.1",
      userId: "U1",
      text: "hello",
      permalink: "https://s/1",
      eventId: "Ev1",
    },
  ] as SlackMessage[];
}

/** A live channel plus a real `runs` row, so the write guard can pass. */
async function liveSlackScope() {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'pulsefit', 'live')"
  )
    .bind(channelId, `chan-${channelId}`)
    .run();
  const threadTs = `${Math.floor(Date.now() / 1000)}.${crypto.randomUUID().slice(0, 6)}`;
  const run = await createOrGetRun(env.DB, {
    key: `slack:${channelId}:${threadTs}`,
    origin: "slack",
    channelId,
    threadTs,
  });
  return {
    runId: run.id,
    origin: "slack" as const,
    customerSlug: "pulsefit",
    slackThread: { channelId, threadTs },
    actor: { engineerEmail: "ronit@zellify.app", slackUserId: "U0RONIT" },
  };
}

describe("slack.thread", () => {
  it("returns only the model-visible fields, never the stored event id", async () => {
    const slack = {
      thread: vi.fn(async () => messages()),
    } as unknown as SlackGateway;
    const ctx = testBindingContext({ deps: { slack } });
    const result = (await makeSlackTools(ctx).thread.run({})) as Record<
      string,
      unknown
    >[];
    expect(result[0]).toEqual({
      ts: "1.1",
      userId: "U1",
      text: "hello",
      permalink: "https://s/1",
    });
    expect(result[0]).not.toHaveProperty("eventId");
  });

  it("tolerates a zero-argument call", async () => {
    // ToolDispatcher.call spreads an empty argument array, so `slack.thread()`
    // reaches execute(undefined). The .default({}) is what makes that work.
    const slack = { thread: vi.fn(async () => []) } as unknown as SlackGateway;
    await expect(
      makeSlackTools(testBindingContext({ deps: { slack } })).thread.run(
        undefined
      )
    ).resolves.toEqual([]);
  });
});

describe("slack.reply", () => {
  it("refuses when the run has no thread", async () => {
    // A real, non-shadow chat run: the shared write guard passes, so the
    // refusal that fires is the reply-specific one rather than the guard's.
    const run = await createOrGetRun(env.DB, {
      key: `chat:${crypto.randomUUID()}`,
      origin: "chat",
      channelId: null,
      threadTs: null,
    });
    const ctx = testBindingContext({
      scope: { runId: run.id, origin: "chat", slackThread: null },
    });
    await expect(
      makeSlackTools(ctx).reply.run({ text: "hi" })
    ).rejects.toMatchObject({
      code: "slack_context_required",
    });
  });

  it("fails closed when the run row cannot be confirmed at all", async () => {
    // The shared guard runs first and refuses an unconfirmable run before any
    // reply-specific check gets a say.
    const ctx = testBindingContext();
    await expect(
      makeSlackTools(ctx).reply.run({ text: "hi" })
    ).rejects.toMatchObject({
      code: "shadow_write_denied",
    });
  });

  it("refuses when no engineer identity is resolved", async () => {
    // This product never speaks to a customer without a human behind it.
    const scope = await liveSlackScope();
    const ctx = testBindingContext({ scope: { ...scope, actor: null } });
    await expect(
      makeSlackTools(ctx).reply.run({ text: "hi" })
    ).rejects.toMatchObject({
      code: "identity_unavailable",
    });
  });

  it("refuses from a shadow run before reaching the gateway", async () => {
    const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, NULL, 'observe')"
    )
      .bind(channelId, "obs")
      .run();
    const threadTs = `${Math.floor(Date.now() / 1000)}.${crypto.randomUUID().slice(0, 6)}`;
    const run = await createOrGetRunUnderPolicy(
      env.DB,
      {
        key: `slack:${channelId}:${threadTs}`,
        origin: "slack",
        channelId,
        threadTs,
      },
      { mustShadow: true }
    );
    const reply = vi.fn();
    const ctx = testBindingContext({
      scope: {
        runId: run.id,
        origin: "slack",
        slackThread: { channelId, threadTs },
        actor: { engineerEmail: "ronit@zellify.app", slackUserId: "U1" },
      },
      deps: { slack: { reply } as unknown as SlackGateway },
    });
    await expect(
      makeSlackTools(ctx).reply.run({ text: "hi" })
    ).rejects.toThrow();
    expect(reply).not.toHaveBeenCalled();
  });

  it("sends once for two identical replies in one turn", async () => {
    // The ledger reserves before the send, so a retry after a transport error
    // replays rather than posting to a customer twice.
    const scope = await liveSlackScope();
    const reply = vi.fn(async () => ({ ts: "9.9", permalink: null }));
    const ctx = testBindingContext({
      scope,
      deps: { slack: { reply } as unknown as SlackGateway },
    });
    const tools = makeSlackTools(ctx);
    await tools.reply.run({ text: "on it" });
    await tools.reply.run({ text: "on it" });
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("hands the gateway an idempotency key", async () => {
    const scope = await liveSlackScope();
    const reply = vi.fn(async () => ({ ts: "9.9", permalink: null }));
    const ctx = testBindingContext({
      scope,
      deps: { slack: { reply } as unknown as SlackGateway },
    });
    await makeSlackTools(ctx).reply.run({ text: "on it" });
    expect(reply).toHaveBeenCalledWith("on it", expect.any(String));
  });

  it("takes no destination argument", () => {
    // Where a reply lands is a property of the run, decided by the host before
    // model code ran.
    const rendered = JSON.stringify(
      makeSlackTools(testBindingContext()).reply.input
    );
    expect(rendered).not.toMatch(/channel|thread|destination/i);
  });
});

describe("slack.searchMessages — customer scope", () => {
  it("refuses a customerRef on a Slack-origin run", async () => {
    // Ignoring it would be worse than refusing: the model would believe it had
    // scoped the search and reason about the answer as if it had.
    const scope = await liveSlackScope();
    const ctx = testBindingContext({ scope });
    await expect(
      makeSlackTools(ctx).searchMessages.run({
        query: "checkout",
        customerRef: "cust_x",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a guessed reference on a chat run", async () => {
    const ctx = testBindingContext({ scope: { origin: "chat" } });
    await expect(
      makeSlackTools(ctx).searchMessages.run({
        query: "checkout",
        customerRef: "pulsefit",
      })
    ).rejects.toThrow();
  });

  it("refuses when a chat run has no customer scope at all", async () => {
    const ctx = testBindingContext({
      scope: { origin: "chat", customerSlug: null },
    });
    await expect(
      makeSlackTools(ctx).searchMessages.run({ query: "checkout" })
    ).rejects.toMatchObject({ code: "customer_scope_required" });
  });

  it("passes the channel's pinned slug on a Slack run", async () => {
    const scope = await liveSlackScope();
    const searchMessages = vi.fn(async () => messages());
    const ctx = testBindingContext({
      scope,
      deps: { slack: { searchMessages } as unknown as SlackGateway },
    });
    await makeSlackTools(ctx).searchMessages.run({ query: "checkout" });
    expect(searchMessages).toHaveBeenCalledWith("checkout", 20, "pulsefit");
  });
});
