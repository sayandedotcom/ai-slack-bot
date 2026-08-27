import { Hono } from "hono";
import type { Env } from "../index";
import { verifySlackSignature } from "./verify";
import type { QueuedEvent, SlackEnvelope } from "./types";

export const slackEvents = new Hono<{ Bindings: Env }>();

/**
 * Slack requires a response within 3 seconds and retries up to three times
 * otherwise. This handler therefore does exactly three things: verify, enqueue,
 * 200. No D1 write, no fetch, no logging round-trip. See spec §4.1.
 */
slackEvents.post("/events", async (c) => {
  const rawBody = await c.req.text();

  const ok = await verifySlackSignature({
    signingSecret: c.env.SLACK_SIGNING_SECRET,
    signature: c.req.header("x-slack-signature") ?? null,
    timestamp: c.req.header("x-slack-request-timestamp") ?? null,
    rawBody,
  });
  if (!ok) return c.text("invalid signature", 401);

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return c.text("bad json", 400);
  }

  if (envelope.type === "url_verification") {
    return c.json({ challenge: envelope.challenge });
  }

  if (
    envelope.type === "event_callback" &&
    envelope.event?.type === "message"
  ) {
    const queued: QueuedEvent = {
      event_id: envelope.event_id,
      event: envelope.event,
      received_at: Date.now(),
    };
    await c.env.INGEST_QUEUE.send(queued);
  }

  // Anything else is acknowledged and ignored. Never 500 at Slack: it retries.
  return c.text("ok", 200);
});
