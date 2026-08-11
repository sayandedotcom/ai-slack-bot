import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIngestBatch } from "../src/ingest/consumer";
import type { QueuedEvent } from "../src/slack/types";

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

function ev(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    event_id: "Ev1",
    received_at: 1_700_000_000_000,
    event: {
      type: "message",
      channel: "C_TEST",
      channel_type: "channel",
      user: "U1",
      text: "the checkout button is broken",
      ts: "1700000000.000100",
    },
    ...overrides,
  };
}

// The consumer backfills permalinks via Slack. Without a stub these tests make
// real requests to slack.com — slow, and flaky offline. `fetchMock` used to
// block this; it was removed in vitest-pool-workers v0.21. Returning ok:false
// exercises the path the plan intends: permalink resolution fails, the message
// is still written.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ok: false, error: "message_not_found" }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM events_seen"),
    env.DB.prepare("DELETE FROM channels"),
  ]);
  await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
    .bind("C_TEST", "test-firedrill", "firedrill", "live")
    .run();
});

describe("handleIngestBatch", () => {
  it("writes an events_seen row and a messages row", async () => {
    await handleIngestBatch(batchOf([ev()]), env);

    const seen = await env.DB.prepare("SELECT * FROM events_seen").first<{ outcome: string }>();
    expect(seen?.outcome).toBe("ingested");

    const msg = await env.DB.prepare("SELECT * FROM messages").first<{
      text: string;
      customer_slug: string;
      channel_id: string;
    }>();
    expect(msg?.text).toBe("the checkout button is broken");
    expect(msg?.customer_slug).toBe("firedrill");
    expect(msg?.channel_id).toBe("C_TEST");
  });

  it("is idempotent — a Slack retry writes exactly one row", async () => {
    await handleIngestBatch(batchOf([ev()]), env);
    await handleIngestBatch(batchOf([ev()]), env);

    const seen = await env.DB.prepare("SELECT COUNT(*) AS n FROM events_seen").first<{ n: number }>();
    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(seen?.n).toBe(1);
    expect(msgs?.n).toBe(1);
  });

  it("records a dropped DM in events_seen but not in messages", async () => {
    const dm = ev({ event_id: "Ev_dm" });
    dm.event.channel_type = "im";
    await handleIngestBatch(batchOf([dm]), env);

    const seen = await env.DB.prepare("SELECT outcome FROM events_seen WHERE event_id = ?")
      .bind("Ev_dm")
      .first<{ outcome: string }>();
    expect(seen?.outcome).toBe("dropped_dm");

    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(msgs?.n).toBe(0);
  });

  it("drops an unknown channel", async () => {
    const unknown = ev({ event_id: "Ev_unknown" });
    unknown.event.channel = "C_NOT_MAPPED";
    await handleIngestBatch(batchOf([unknown]), env);

    const seen = await env.DB.prepare("SELECT outcome FROM events_seen WHERE event_id = ?")
      .bind("Ev_unknown")
      .first<{ outcome: string }>();
    expect(seen?.outcome).toBe("dropped_unknown_channel");
  });

  it("stores thread_ts when present", async () => {
    const reply = ev({ event_id: "Ev_reply" });
    reply.event.thread_ts = "1700000000.000000";
    await handleIngestBatch(batchOf([reply]), env);

    const msg = await env.DB.prepare("SELECT thread_ts FROM messages WHERE event_id = ?")
      .bind("Ev_reply")
      .first<{ thread_ts: string }>();
    expect(msg?.thread_ts).toBe("1700000000.000000");
  });

  it("ingests reference-channel messages — observe blocks posting, not hearing", async () => {
    await env.DB.prepare("INSERT INTO channels VALUES (?, ?, ?, ?)")
      .bind("C_REF", "pulsefit-zellify", "pulsefit", "observe")
      .run();
    const refMsg = ev({ event_id: "Ev_ref" });
    refMsg.event.channel = "C_REF";
    await handleIngestBatch(batchOf([refMsg]), env);

    const msg = await env.DB.prepare("SELECT customer_slug FROM messages WHERE event_id = ?")
      .bind("Ev_ref")
      .first<{ customer_slug: string }>();
    expect(msg?.customer_slug).toBe("pulsefit");
  });

  it("processes a mixed batch without one bad event blocking the rest", async () => {
    const bad = ev({ event_id: "Ev_bad" });
    bad.event.channel_type = "im";
    await handleIngestBatch(batchOf([bad, ev({ event_id: "Ev_good" })]), env);

    const msgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(msgs?.n).toBe(1);
  });
});
