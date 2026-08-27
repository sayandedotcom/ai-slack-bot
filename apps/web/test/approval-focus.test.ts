import { describe, expect, it } from "vitest";

import {
  approvalDomId,
  nextApprovalFocus,
} from "@/lib/hooks/use-selected-approval";

/**
 * The deep link from a Slack nudge. `apps/worker/src/notify/blocks.ts` builds
 * every approval DM's Review button as `${DASHBOARD_BASE_URL}/?approval=<id>`,
 * and until this helper existed the dashboard ignored the parameter entirely.
 *
 * The rule under test is a TIMING rule, which is why it is a pure function at
 * all: the queue refetches every three seconds, so "scroll to this card" has to
 * mean once per id, not once per poll.
 */
describe("nextApprovalFocus", () => {
  const present = ["apr-1", "apr-2"];

  it("does nothing when no approval was deep-linked to", () => {
    expect(
      nextApprovalFocus({ requested: null, alreadyFocused: null, present })
    ).toBeNull();
  });

  it("focuses a requested card that is in the queue", () => {
    expect(
      nextApprovalFocus({ requested: "apr-2", alreadyFocused: null, present })
    ).toBe("apr-2");
  });

  it("fires once per id, so a poll does not re-scroll under the reader", () => {
    expect(
      nextApprovalFocus({
        requested: "apr-2",
        alreadyFocused: "apr-2",
        present,
      })
    ).toBeNull();
  });

  it("re-focuses when the link changes to a different approval", () => {
    expect(
      nextApprovalFocus({
        requested: "apr-1",
        alreadyFocused: "apr-2",
        present,
      })
    ).toBe("apr-1");
  });

  it("stays silent for an id the queue does not hold, rather than jumping nowhere", () => {
    // The common case for this is an approval somebody else already decided:
    // it has left the open list, and the nudge in Slack outlives it.
    expect(
      nextApprovalFocus({ requested: "apr-9", alreadyFocused: null, present })
    ).toBeNull();
  });

  it("stays silent while the queue is still loading", () => {
    expect(
      nextApprovalFocus({
        requested: "apr-1",
        alreadyFocused: null,
        present: [],
      })
    ).toBeNull();
  });
});

describe("approvalDomId", () => {
  it("is the one place the queue's scroll and the card's attribute agree", () => {
    expect(approvalDomId("apr-1")).toBe("approval-apr-1");
  });
});
