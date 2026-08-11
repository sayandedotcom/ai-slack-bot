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
