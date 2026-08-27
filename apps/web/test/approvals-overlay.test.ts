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
    store().resolve(card, "approved", "devon@example.com", false);

    // The first timer must not fire and remove the card 100ms from now.
    vi.advanceTimersByTime(200);
    expect(store().cards.has(card.id)).toBe(true);

    vi.advanceTimersByTime(RESOLVED_TTL_MS);
    expect(store().cards.has(card.id)).toBe(false);
  });

  it("fills in a decider's name but never changes the decision", () => {
    store().resolve(card, "approved", null, false);
    store().nameDecider(card.id, "devon@example.com");

    expect(store().cards.get(card.id)).toMatchObject({
      kind: "resolved",
      decision: "approved",
      decidedBy: "devon@example.com",
    });
  });

  it("refuses to name a decider on a card that is not resolved", () => {
    store().beginDecide(card, { action: "approve" });
    store().nameDecider(card.id, "devon@example.com");

    expect(store().cards.get(card.id)).toMatchObject({ kind: "deciding" });
  });

  it("never overwrites a name that is already known", () => {
    store().resolve(card, "approved", "blake@example.com", false);
    store().nameDecider(card.id, "devon@example.com");

    expect(store().cards.get(card.id)).toMatchObject({
      decidedBy: "blake@example.com",
    });
  });

  it("lets exactly one caller claim an id for reconciliation", () => {
    expect(store().claimReconcile(card.id)).toBe(true);
    expect(store().claimReconcile(card.id)).toBe(false);
  });

  it("holds a vanished card without clobbering a state it already has", () => {
    store().beginDecide(card, { action: "approve" });
    store().hold(card);
    expect(store().cards.get(card.id)).toMatchObject({ kind: "deciding" });
  });
});
