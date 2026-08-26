import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@workspace/ui/components/tooltip";

import { ApprovalCard } from "@/components/dashboard/approval-card";
import type { OpenApproval } from "@/lib/api/approvals";
import type { CardState } from "@/lib/store/approvals-overlay";

const card: OpenApproval = {
  id: "apr-1",
  runId: "run-1",
  draft: "We've rolled back the deploy behind this morning's 502s.",
  why: "Commits the team to a rollback, so a human should sign it off.",
  channelId: "C0ACME",
  threadTs: "1786650000.000100",
  createdAt: Date.now() - 90_000,
};

function renderCard(state: CardState, role: "firefighter" | "viewer" = "firefighter") {
  const onDecide = vi.fn();
  render(
    <TooltipProvider>
      <ul>
        <ApprovalCard state={state} role={role} onDecide={onDecide} />
      </ul>
    </TooltipProvider>,
  );
  return { onDecide };
}

describe("ApprovalCard", () => {
  it("leads with why the human is being interrupted", () => {
    renderCard({ kind: "open", card });
    expect(screen.getByText(card.why)).toBeInTheDocument();
  });

  it("approves in one click, because the draft being right is the common case", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderCard({ kind: "open", card });

    await user.click(screen.getByRole("button", { name: /approve & send/i }));
    expect(onDecide).toHaveBeenCalledWith({ action: "approve" });
  });

  it("keeps reject disabled until a reason exists", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderCard({ kind: "open", card });

    await user.click(screen.getByRole("button", { name: /^reject$/i }));

    // The reason is training data, so the send is gated on it here as well as
    // by the API's 422.
    const send = screen.getByRole("button", { name: /^reject$/i });
    expect(send).toBeDisabled();

    await user.type(screen.getByLabelText(/rejection reason/i), "We haven't agreed to a rollback.");
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    expect(onDecide).toHaveBeenCalledWith({
      action: "reject",
      reason: "We haven't agreed to a rollback.",
    });
  });

  it("edits inline so the reason for the escalation stays on screen", async () => {
    const user = userEvent.setup();
    renderCard({ kind: "open", card });

    await user.click(screen.getByRole("button", { name: /edit/i }));

    // A modal would hide the `why` at the exact moment it is being written against.
    expect(screen.getByLabelText(/edited reply/i)).toBeInTheDocument();
    expect(screen.getByText(card.why)).toBeInTheDocument();
  });

  it("gives a viewer no way to act, and says who does", () => {
    renderCard({ kind: "open", card }, "viewer");

    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/fire-fighters decide/i)).toBeInTheDocument();
  });

  it("locks every control while a decision is in flight", () => {
    renderCard({ kind: "deciding", card, action: { action: "approve" } });

    expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /edit/i })).toBeDisabled();
  });

  it("shows a failed decision as open with a sentence, never as done", () => {
    renderCard({ kind: "open", card, error: "Could not send that decision. Try again." });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not send that decision.");
    expect(screen.getByRole("button", { name: /approve & send/i })).toBeEnabled();
  });

  it("names the winner of a race when it knows one", () => {
    renderCard({
      kind: "resolved",
      card,
      decision: "approved",
      decidedBy: "zurab@zellify.app",
      mine: false,
    });
    expect(screen.getByText(/zurab@zellify\.app approved this before you/i)).toBeInTheDocument();
  });

  it("stays truthful when the 409 carried no name", () => {
    // The worker's conflict body has `decision` and no `decidedBy`, so this is
    // the COMMON path, not an edge case.
    renderCard({ kind: "resolved", card, decision: "edited", decidedBy: null, mine: false });
    expect(screen.getByText(/someone else edited this first/i)).toBeInTheDocument();
  });

  it("blames nobody when the agent withdrew its own ask", () => {
    renderCard({ kind: "resolved", card, decision: "withdrawn", decidedBy: null, mine: false });
    expect(screen.getByText(/the agent withdrew this/i)).toBeInTheDocument();
  });
});
