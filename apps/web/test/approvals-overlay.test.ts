import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenApproval } from "@/lib/api/approvals";
import {
  RESOLVED_TTL_MS,
  useApprovalsOverlay,
} from "@/lib/store/approvals-overlay";

/**
 * The overlay is a plain store, so its state machine is testable without
 * rendering anything — which is most of why it is a store.
 */

const card: OpenApproval = {
  id: "apr-1",
  runId: "run-1",
  draft: "We've rolled back the deploy.",
  why: "Commits to a rollback.",
  channelId: "C0ACME",
  threadTs: "1786650000.000100",
  createdAt: 1_786_650_000_000,
};

const store = () => useApprovalsOverlay.getState();

beforeEach(() => {
  vi.useFakeTimers();
  store().reset();
});

afterEach(() => {
  store().reset();
  vi.useRealTimers();
});

describe("the approvals overlay", () => {
  it("locks a card while its decision is in flight", () => {
    store().beginDecide(card, { action: "approve" });
    expect(store().cards.get(card.id)).toMatchObject({ kind: "deciding" });
  });

  it("puts a failed decision back to open with a sentence, never to resolved", () => {
    store().beginDecide(card, { action: "approve" });
    store().failDecide(card, "Could not send that decision. Try again.");

    const entry = store().cards.get(card.id);
    // "We don't know" must not render as "done".
    expect(entry).toMatchObject({
      kind: "open",
      error: "Could not send that decision. Try again.",
    });
  });

  it("expires a resolved card after the TTL", () => {
    store().resolve(card, "approved", null, true);
    expect(store().cards.get(card.id)).toMatchObject({
      kind: "resolved",
      mine: true,
    });

    vi.advanceTimersByTime(RESOLVED_TTL_MS - 1);
    expect(store().cards.has(card.id)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(store().cards.has(card.id)).toBe(false);
  });

  it("restarts the countdown rather than stacking timers when a card resolves twice", () => {
    store().resolve(card, "approved", null, true);
    vi.advanceTimersByTime(RESOLVED_TTL_MS - 100);
    store().resolve(card, "approved", "zurab@zellify.app", false);

    // The first timer must not fire and remove the card 100ms from now.
    vi.advanceTimersByTime(200);
    expect(store().cards.has(card.id)).toBe(true);

    vi.advanceTimersByTime(RESOLVED_TTL_MS);
    expect(store().cards.has(card.id)).toBe(false);
  });

  it("takes a decider's name directly off a resolve call, from the 409 body — never invented", () => {
    store().resolve(card, "approved", "zurab@zellify.app", false);

    expect(store().cards.get(card.id)).toMatchObject({
      kind: "resolved",
      decision: "approved",
      decidedBy: "zurab@zellify.app",
    });
  });

  it("no longer carries a reconcile set — a vanished card is explained by the decided list", () => {
    const s = useApprovalsOverlay.getState() as Record<string, unknown>;
    expect("claimReconcile" in s).toBe(false);
    expect("reconciled" in s).toBe(false);
  });
});
