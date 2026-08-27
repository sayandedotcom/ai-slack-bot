/**
 * The run-view approvals surface (`src/approvals/run-approvals.tsx`) and the one
 * write behind it.
 *
 * Two invariants, both of which the Think chassis makes easy to get wrong:
 *
 *  1. A decision is committed by the Worker — `PATCH /api/approvals/:id`, which
 *     takes the roster check and the D1 CAS before it ever reaches
 *     `RunAgent.resolveApproval`. On the Think chassis the run object is also
 *     reachable from the browser over the Agents SDK's `/agents/*` transport, so
 *     "just call the agent" is a live temptation and would skip both gates.
 *     `resolveApproval` is deliberately not `@callable` for exactly this reason.
 *  2. Losing the race is an outcome, not a failure. A 409 must render as the
 *     winner's decision, not as an error banner — the operator whose click lost
 *     needs to know what was actually sent, and an error toast tells them the
 *     opposite of the truth.
 *
 * Harness note: this package has NO DOM (`vite.config.ts` is the whole vitest
 * config; there is no jsdom and no testing-library). Rendering here is
 * `react-dom/server`'s `renderToStaticMarkup`, which needs no document. That is
 * enough to pin the copy a card renders for a given state, but it cannot run
 * effects — so `useApprovals`' own async 409 -> `resolved` transition is not
 * reachable from this file. The mapping it performs is reproduced below at the
 * one line that matters (`mine: false`, decision from the 409 body, name left
 * `null`) and marked as such.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decide, type OpenApproval } from "../src/approvals/api";
import type { CardState } from "../src/approvals/approval-card";
import { RunApprovals } from "../src/approvals/run-approvals";
import type { PanelState } from "../src/components/panel";

function stubFetch(
  impl: (input: string, init?: RequestInit) => Promise<Response> | Response
) {
  const spy = vi.fn((input: unknown, init?: unknown) =>
    impl(String(input), init as RequestInit)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CARD: OpenApproval = {
  id: "ap_1",
  runId: "run_1",
  draft: "restarting the ingest worker now",
  why: "committal reply to the customer",
  channelId: "C1",
  threadTs: "1700000000.0001",
  createdAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deciding an approval from the run view", () => {
  it("sends the decision to PATCH /api/approvals/:id and opens no agent transport at all", async () => {
    const fetchSpy = stubFetch(() =>
      jsonResponse(200, { approval: { ...CARD, decision: "approved" } })
    );
    // The Agents SDK reaches `RunAgent` over a WebSocket under `/agents/*`. If a
    // decision ever went that way instead, it would show up here.
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);

    // An id with characters that must survive encoding — a decision addressed to
    // the wrong row is worse than a failed one.
    const result = await decide("ap 1/2", { action: "approve" });
    expect(result).toEqual({ result: "decided", decision: "approved" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe(`/api/approvals/${encodeURIComponent("ap 1/2")}`);
    expect(String(url)).not.toContain("/agents");
    expect(init.method).toBe("PATCH");
    // Same-origin: the Access cookie is the only credential, and there is no
    // backend URL or token in the bundle to send anywhere else.
    expect(init.credentials).toBe("same-origin");
    expect(socket).not.toHaveBeenCalled();
  });

  it("renders a 409 as the winner's decision rather than as an error banner", async () => {
    stubFetch(() =>
      jsonResponse(409, {
        code: "already_decided",
        message: "already decided",
        decision: "rejected",
      })
    );

    const outcome = await decide(CARD.id, { action: "approve" });
    expect(outcome).toEqual({
      result: "already_decided",
      decision: "rejected",
      decidedBy: null,
    });
    if (outcome.result !== "already_decided") throw new Error("unreachable");

    // This is `use-approvals.ts`'s own mapping for a lost race, inlined because
    // the hook's effects cannot run without a DOM: the card goes to `resolved`,
    // the decision comes from the 409 body and only from there, `mine` is false,
    // and the winner has no name because the conflict body carries none.
    const state: PanelState<CardState[]> = {
      kind: "ready",
      data: [
        {
          kind: "resolved",
          card: CARD,
          decision: outcome.decision,
          decidedBy: outcome.decidedBy,
          mine: false,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      createElement(RunApprovals, {
        runId: CARD.runId,
        state,
        role: "firefighter" as const,
        onDecide: () => {
          throw new Error("a resolved card must offer nothing to click");
        },
      })
    );

    expect(markup).toContain("Someone else rejected this first");
    // Not an error: no alert role anywhere, and none of the panel's failure copy.
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("Could not");
    expect(markup).not.toContain("Try again");
    // And not still actionable — the race is over.
    expect(markup).not.toContain("Approve");
  });
});
