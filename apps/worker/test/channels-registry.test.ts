import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveSlug, registerChannel, sweepChannelMembership } from "../src/channels/registry";
import { getChannelPolicy } from "../src/db/channels";
import { handleIngestBatch } from "../src/ingest/consumer";
import type { QueuedEvent } from "../src/slack/types";

/**
 * Every case mints its own channel id. Storage is shared across tests AND
 * across files (no `isolatedStorage`), so a fixed id would collide with
 * whatever `ingest.test.ts` last wrote — and this suite's whole subject is
 * whether a row exists.
 */
function freshChannelId(): string {
  return `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/**
 * Route Slack calls by method. The registry reaches Slack for two things and
 * nothing else, so anything unrouted answers `ok:false` and any accidental
 * dependency shows up as a failure rather than a live request.
 */
function stubSlack(routes: {
  info?: { name: string; is_im?: boolean; is_mpim?: boolean } | null;
  conversations?: { id: string; name: string }[];
  infoHttpError?: boolean;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.includes("conversations.info")) {
      if (routes.infoHttpError === true) return new Response("nope", { status: 500 });
      if (!routes.info) return Response.json({ ok: false, error: "channel_not_found" });
      const id = new URL(url).searchParams.get("channel");
      return Response.json({ ok: true, channel: { id, ...routes.info } });
    }

    if (url.includes("users.conversations")) {
      return Response.json({ ok: true, channels: routes.conversations ?? [] });
    }

    // chat.getPermalink and anything else.
    return Response.json({ ok: false, error: "message_not_found" });
  });
}

function batchOf(events: QueuedEvent[]) {
  return {
    queue: "firefighter-ingest",
    messages: events.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    })),
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<QueuedEvent>;
}

function ev(channel: string, overrides: Partial<QueuedEvent["event"]> = {}): QueuedEvent {
  return {
    event_id: `Ev${crypto.randomUUID().slice(0, 12)}`,
    received_at: 1_700_000_000_000,
    event: {
      type: "message",
      channel,
      channel_type: "channel",
      user: "U1",
      text: "the export is timing out for our team",
      ts: `17000000${Math.floor(Math.random() * 100)}.000100`,
      ...overrides,
    },
  } as QueuedEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveSlug", () => {
  it("slugifies a channel name", () => {
    expect(deriveSlug("Ext Acme Corp", "C1")).toBe("ext-acme-corp");
    expect(deriveSlug("ff-test", "C1")).toBe("ff-test");
    expect(deriveSlug("team_alpha.2", "C1")).toBe("team-alpha-2");
  });

  it("falls back to the channel id when a name reduces to nothing", () => {
    // The slug is the Zep graph id and the Supabase tenant filter, so it can
    // never be the empty string.
    expect(deriveSlug("---", "C0ABC")).toBe("c0abc");
    expect(deriveSlug("", "C0ABC")).toBe("c0abc");
  });
});

describe("registerChannel", () => {
  it("registers an unknown channel as live, with a slug from its name", async () => {
    const id = freshChannelId();
    stubSlack({ info: { name: "ext-acme" } });

    const policy = await registerChannel(env, id);

    expect(policy?.known).toBe(true);
    expect(policy?.name).toBe("ext-acme");
    expect(policy?.customer_slug).toBe("ext-acme");
    // Invite is consent: a newly discovered channel is triaged AND postable.
    expect(policy?.mode).toBe("live");
  });

  it("never overwrites an existing row", async () => {
    // The human's decision wins. A channel demoted to observe must not be
    // silently promoted back to live by the next message that arrives in it.
    const id = freshChannelId();
    await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
      .bind(id, "renamed-since", "the-real-tenant", "observe")
      .run();
    stubSlack({ info: { name: "brand-new-name" } });

    const policy = await registerChannel(env, id);

    expect(policy?.mode).toBe("observe");
    expect(policy?.customer_slug).toBe("the-real-tenant");
  });

  it("returns null and writes nothing when Slack cannot identify the channel", async () => {
    // Registering under a fallback name was rejected: the slug is derived from
    // the name and a wrong slug is permanent.
    const id = freshChannelId();
    stubSlack({ infoHttpError: true });

    expect(await registerChannel(env, id)).toBeNull();
    expect((await getChannelPolicy(env.DB, id)).known).toBe(false);
  });

  it("refuses a DM even if one somehow reaches it", async () => {
    const id = freshChannelId();
    stubSlack({ info: { name: "mpdm-a--b", is_mpim: true } });

    expect(await registerChannel(env, id)).toBeNull();
    expect((await getChannelPolicy(env.DB, id)).known).toBe(false);
  });

  it("is idempotent across repeated registration", async () => {
    const id = freshChannelId();
    stubSlack({ info: { name: "repeat-me" } });

    await registerChannel(env, id);
    await registerChannel(env, id);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels WHERE channel_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe("sweepChannelMembership", () => {
  it("registers a channel nobody has spoken in yet", async () => {
    const id = freshChannelId();
    stubSlack({ conversations: [{ id, name: "quiet-channel" }] });

    const result = await sweepChannelMembership(env);

    expect(result.registered).toBeGreaterThanOrEqual(1);
    const policy = await getChannelPolicy(env.DB, id);
    expect(policy.known).toBe(true);
    expect(policy.customer_slug).toBe("quiet-channel");
  });

  it("leaves an already-registered channel untouched", async () => {
    const id = freshChannelId();
    await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
      .bind(id, "already-here", "pinned-slug", "observe")
      .run();
    stubSlack({ conversations: [{ id, name: "already-here" }] });

    await sweepChannelMembership(env);

    const policy = await getChannelPolicy(env.DB, id);
    expect(policy.mode).toBe("observe");
    expect(policy.customer_slug).toBe("pinned-slug");
  });

  it("registers nothing when Slack fails", async () => {
    // `[]` on failure is what stops an outage from looking like "the bot is in
    // no channels". Nothing is added, and nothing is ever removed.
    stubSlack({ conversations: [] });
    expect((await sweepChannelMembership(env)).registered).toBe(0);
  });
});

describe("ingest registers an unknown channel", () => {
  it("triages the very first message from a channel nobody seeded", async () => {
    const id = freshChannelId();
    stubSlack({ info: { name: "new-customer" } });
    const sent: unknown[] = [];
    const testEnv = {
      ...env,
      TRIAGE_QUEUE: { send: async (m: unknown) => void sent.push(m) },
      MEMORY_QUEUE: { send: async () => {} },
    } as unknown as typeof env;

    await handleIngestBatch(batchOf([ev(id)]), testEnv);

    const policy = await getChannelPolicy(env.DB, id);
    expect(policy.known).toBe(true);
    expect(policy.customer_slug).toBe("new-customer");

    // The message that revealed the channel is itself triaged — the point of
    // the lazy path over waiting for the sweep.
    expect(sent).toHaveLength(1);

    const msg = await env.DB.prepare("SELECT customer_slug FROM messages WHERE channel_id = ?")
      .bind(id)
      .first<{ customer_slug: string }>();
    expect(msg?.customer_slug).toBe("new-customer");
  });

  it("never registers a DM", async () => {
    // classify() drops the DM before registration is reached, so no
    // conversations.info call is made at all.
    const id = `D${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    stubSlack({ info: { name: "should-never-be-used" } });

    await handleIngestBatch(batchOf([ev(id, { channel_type: "im" })]), env);

    expect((await getChannelPolicy(env.DB, id)).known).toBe(false);
  });
});
