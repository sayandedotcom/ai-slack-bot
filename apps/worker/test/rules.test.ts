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

  it("drops unknown channels even when everything else is fine", () => {
    expect(classify(base, false)).toBe("dropped_unknown_channel");
  });

  it("checks DM before channel membership, so a DM in an unknown channel is dropped as a DM", () => {
    expect(classify({ ...base, channel_type: "im" }, false)).toBe("dropped_dm");
  });

  it("ingests a thread reply", () => {
    expect(classify({ ...base, thread_ts: "1.0" }, true)).toBe("ingested");
  });

  it("ingests a message with empty text rather than dropping it", () => {
    expect(classify({ ...base, text: "" }, true)).toBe("ingested");
  });
});
