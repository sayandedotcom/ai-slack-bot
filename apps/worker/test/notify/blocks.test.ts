import { describe, expect, it } from "vitest";
import { nudgeBlocks, resolvedBlocks } from "../../src/notify/blocks";

/**
 * Pure Block Kit payload builders — no I/O, no Slack client. `nudgeBlocks`
 * is the engineer DM body; `resolvedBlocks` is what `chat.update` replaces
 * it with once a decision lands. Both just return plain, JSON-serializable
 * objects; the orchestration that sends/updates them is Phase 13's later
 * task.
 */

const DASHBOARD_URL = "https://firefighter.sayandeten.workers.dev";
const APPROVAL_ID = "apr:1";
const CHANNEL_NAME = "eng-support";
const WHY = "it commits us to a date in front of the customer";

function findActionsBlock(blocks: object[]): any {
  return (blocks as any[]).find((b) => b.type === "actions");
}

describe("nudgeBlocks", () => {
  const shortDraft = "We can have the migration finished by Friday.";

  it("is JSON-serializable", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks);
  });

  it("contains a section naming the channel to reply to", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain(`Waiting on you: reply to #${CHANNEL_NAME}`);
  });

  it("contains a section with the why", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    expect(JSON.stringify(blocks)).toContain(WHY);
  });

  it("quotes the draft as-is when it is short enough", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    expect(JSON.stringify(blocks)).toContain(shortDraft);
    expect(JSON.stringify(blocks)).not.toContain("truncated");
  });

  it("truncates a long draft at 300 chars with a visible marker", () => {
    const longDraft = "x".repeat(400);
    const blocks = nudgeBlocks({
      draft: longDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("… [truncated]");
    // Full 400-char draft must not appear verbatim.
    expect(text).not.toContain(longDraft);
    // Exactly the first 300 chars survive, immediately followed by the marker.
    expect(text).toContain(longDraft.slice(0, 300) + "… [truncated]");
    expect(text).not.toContain(longDraft.slice(0, 301));
  });

  it("has exactly one actions block with one URL button and no interactivity value", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    const actionsBlocks = (blocks as any[]).filter((b) => b.type === "actions");
    expect(actionsBlocks).toHaveLength(1);
    const elements = actionsBlocks[0].elements;
    expect(elements).toHaveLength(1);
    const button = elements[0];
    expect(button.type).toBe("button");
    expect(button.url).toBe(
      `${DASHBOARD_URL}/approvals?approval=${APPROVAL_ID}`
    );
    expect(button).not.toHaveProperty("value");
  });

  it("labels the button Review", () => {
    const blocks = nudgeBlocks({
      draft: shortDraft,
      why: WHY,
      approvalId: APPROVAL_ID,
      dashboardUrl: DASHBOARD_URL,
      channelName: CHANNEL_NAME,
    });
    const button = findActionsBlock(blocks).elements[0];
    expect(button.text.text).toBe("Review");
  });
});

describe("resolvedBlocks", () => {
  it("renders a one-line approved status naming who decided", () => {
    const blocks = resolvedBlocks({
      decision: "approved",
      decidedBy: "ronit@zellify.app",
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("ronit@zellify.app");
    expect(text.toLowerCase()).toContain("approved");
  });

  it("renders a one-line edited status naming who decided", () => {
    const blocks = resolvedBlocks({
      decision: "edited",
      decidedBy: "ronit@zellify.app",
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("ronit@zellify.app");
    expect(text.toLowerCase()).toContain("edited");
  });

  it("renders a one-line rejected status naming who decided", () => {
    const blocks = resolvedBlocks({
      decision: "rejected",
      decidedBy: "ronit@zellify.app",
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("ronit@zellify.app");
    expect(text.toLowerCase()).toContain("rejected");
  });

  it("renders a one-line withdrawn status and omits a name when decidedBy is null", () => {
    const blocks = resolvedBlocks({ decision: "withdrawn", decidedBy: null });
    const text = JSON.stringify(blocks);
    expect(text.toLowerCase()).toContain("withdrawn");
    expect(text).not.toContain("null");
  });

  it("contains no actions/button block", () => {
    for (const decision of [
      "approved",
      "edited",
      "rejected",
      "withdrawn",
    ] as const) {
      const blocks = resolvedBlocks({
        decision,
        decidedBy: decision === "withdrawn" ? null : "ronit@zellify.app",
      });
      expect(findActionsBlock(blocks)).toBeUndefined();
      expect(JSON.stringify(blocks)).not.toContain('"button"');
    }
  });

  it("is JSON-serializable", () => {
    const blocks = resolvedBlocks({
      decision: "approved",
      decidedBy: "ronit@zellify.app",
    });
    expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks);
  });
});
