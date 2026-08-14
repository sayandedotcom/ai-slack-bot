import { describe, expect, it } from "vitest";
import { classify } from "../src/ingest/rules";
import type { SlackMessageEvent } from "../src/slack/types";

const base: SlackMessageEvent = {
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  text: "hello",
  ts: "1.1",
};

describe("classify", () => {
  it("ingests an ordinary channel message", () => {
    expect(classify(base, true)).toBe("ingested");
  });

  it("drops direct messages", () => {
    expect(classify({ ...base, channel_type: "im" }, true)).toBe("dropped_dm");
    expect(classify({ ...base, channel_type: "mpim" }, true)).toBe("dropped_dm");
  });

  it("drops messages from bots", () => {
    expect(classify({ ...base, bot_id: "B1" }, true)).toBe("dropped_bot");
    expect(classify({ ...base, subtype: "bot_message" }, true)).toBe("dropped_bot");
  });

  it("drops join and leave noise", () => {
    expect(classify({ ...base, subtype: "channel_join" }, true)).toBe("dropped_subtype");
    expect(classify({ ...base, subtype: "channel_leave" }, true)).toBe("dropped_subtype");
  });

  it("drops edits and deletions", () => {
    expect(classify({ ...base, subtype: "message_changed" }, true)).toBe("dropped_subtype");
    expect(classify({ ...base, subtype: "message_deleted" }, true)).toBe("dropped_subtype");
  });

  // Core requirement 1: "Every message in every channel the team is in is heard
  // by the webhook and ingested." Only TRIAGE is restricted to customer
  // channels — that gate is shouldTriage(), not this one. An unmapped channel
  // is still ingested; it is simply never postable and never triaged.
  it("ingests messages from unmapped channels", () => {
    expect(classify(base, false)).toBe("ingested");
  });

  it("checks DM before channel membership, so a DM in an unmapped channel is still dropped as a DM", () => {
    expect(classify({ ...base, channel_type: "im" }, false)).toBe("dropped_dm");
  });

  it("still drops bots and noise in unmapped channels", () => {
    expect(classify({ ...base, bot_id: "B1" }, false)).toBe("dropped_bot");
    expect(classify({ ...base, subtype: "channel_join" }, false)).toBe("dropped_subtype");
  });

  it("ingests a thread reply", () => {
    expect(classify({ ...base, thread_ts: "1.0" }, true)).toBe("ingested");
  });

  it("ingests a message with empty text rather than dropping it", () => {
    expect(classify({ ...base, text: "" }, true)).toBe("ingested");
  });
});

/**
 * Self-posts, 2026-08-14. Slack stamps `bot_id` + `app_id` onto EVERY message
 * an app posts through the API — including replies sent with an engineer's
 * USER token (verified live: both agent replies in C0BPGUXG5RS carry
 * `user: <human>` plus `bot_id`/`app_id`). The blanket bot_id drop therefore
 * erased the agent's own replies from D1: the agent could not see what it had
 * promised, and memory never learned what we told the customer.
 *
 * The distinguisher is OUR app_id plus a HUMAN user: a user-token post carries
 * the engineer's user id, a bot-token post (the nudge) carries the bot's own.
 */
describe("classify self-posts", () => {
  const self = { appId: "A_OURS", botUserId: "U_BOT" };
  const selfPost: SlackMessageEvent = {
    ...base,
    bot_id: "B_ANY",
    app_id: "A_OURS",
    user: "U_HUMAN",
  };

  it("ingests our own user-token post as a self-post", () => {
    expect(classify(selfPost, true, self)).toBe("ingested_self");
  });

  it("still drops our own bot-token posts — the nudge must never ingest", () => {
    expect(classify({ ...selfPost, user: "U_BOT" }, true, self)).toBe("dropped_bot");
  });

  it("still drops a foreign app's post even when it names a human user", () => {
    expect(classify({ ...selfPost, app_id: "A_THEIRS" }, true, self)).toBe("dropped_bot");
  });

  it("still drops a bot_id post with no user at all", () => {
    expect(classify({ ...selfPost, user: undefined }, true, self)).toBe("dropped_bot");
  });

  it("still drops subtype bot_message unconditionally", () => {
    expect(classify({ ...selfPost, subtype: "bot_message" }, true, self)).toBe("dropped_bot");
  });

  it("fails safe when no self identity is configured — everything bot-flavored drops", () => {
    expect(classify(selfPost, true)).toBe("dropped_bot");
  });

  it("a self-post DM is still a DM", () => {
    expect(classify({ ...selfPost, channel_type: "im" }, true, self)).toBe("dropped_dm");
  });

  it("a self-post edit is still noise", () => {
    expect(classify({ ...selfPost, subtype: "message_changed" }, true, self)).toBe("dropped_subtype");
  });

  it("a plain human message is untouched by the self config", () => {
    expect(classify(base, true, self)).toBe("ingested");
  });
});
