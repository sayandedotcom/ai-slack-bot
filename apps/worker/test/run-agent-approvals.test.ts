import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";

/**
 * Three cases, and every one of them stands for a failure that is SILENT and
 * lands in front of a customer under a real engineer's name: a decision applied
 * twice, an approved message that is not the text the human typed, and a
 * rejection whose reason never reaches memory.
 *
 * A FRESH key per case. Pool storage is shared across tests and files (no
 * `isolatedStorage`), so a reused key would carry another case's approvals.
 *
 * Nothing here seeds a D1 `runs` row on purpose: the card projection, the send
 * and the memory outbox all resolve the run through D1 and correctly do nothing
 * when it is absent. That is what makes "did not send twice" observable — the
 * delivery column records the send attempt either way, and a run this pool
 * cannot index can never reach Slack from a test.
 */
function agentFor() {
  return getAgentByName<Env, RunAgent>(env.RUN_AGENTS, `chat:${crypto.randomUUID()}`);
}

describe("RunAgent approvals", () => {
  it("applies an approval exactly once and reports the loser its decision", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "We shipped the fix.",
      why: "closes the thread",
    });

    const first = await agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });
    expect(first.status).toBe("resolved");

    // THE CAS. A retried PATCH, a second dashboard tab and the one-minute
    // repair sweep all arrive here, and the second one through must learn what
    // the first decided rather than re-run the send.
    const second = await agent.resolveApproval({
      approvalId,
      decision: { action: "approve" },
      decidedBy: "someone.else@zellify.com",
      decidedAt: 1_700_000_009_000,
    });
    expect(second.status).toBe("already_resolved");

    // The first decision stands whole: the decider, the instant and the
    // delivery outcome are all the first caller's, so nothing about the second
    // call reached the customer or the record.
    if (second.status !== "already_resolved") throw new Error("unreachable");
    expect(second.approval.decidedBy).toBe("engineer@zellify.com");
    expect(second.approval.decidedAt).toBe(1_700_000_000_000);
    expect(second.approval.decision).toBe("approved");

    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record?.decidedBy).toBe("engineer@zellify.com");
    // One send attempt, settled once: a second delivery would have moved this
    // to `in_doubt` through the `none -> sending` guard.
    expect(record?.delivery).toBe("blocked");
    expect(await agent.pendingApprovalsForRun()).toEqual([]);
  });

  it("sends the edited text, not the draft, and keeps both", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Original draft. We will have this out by Friday.",
      why: "closes the thread",
    });

    const outcome = await agent.resolveApproval({
      approvalId,
      decision: { action: "edit", text: "Edited by the engineer. No date promised." },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") throw new Error("unreachable");
    // The edit is the ONLY version that may ever go out, and the draft survives
    // beside it — never instead of it — so memory can learn what was superseded.
    expect(outcome.approval.decision).toBe("edited");
    expect(outcome.approval.editedText).toBe("Edited by the engineer. No date promised.");
    expect(outcome.approval.draft).toBe("Original draft. We will have this out by Friday.");
  });

  it("keeps the rejection reason", async () => {
    const agent = await agentFor();
    const { approvalId } = await agent.escalate({
      draft: "Too promisey.",
      why: "closes the thread",
    });

    const outcome = await agent.resolveApproval({
      approvalId,
      decision: { action: "reject", reason: "overpromises a date" },
      decidedBy: "engineer@zellify.com",
      decidedAt: 1_700_000_000_000,
    });

    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") throw new Error("unreachable");
    expect(outcome.approval.decision).toBe("rejected");
    expect(outcome.approval.rejectReason).toBe("overpromises a date");
    // Nothing was sent, so the delivery sub-machine never ran at all.
    expect(outcome.approval.delivery).toBe("none");

    const [record] = await agent.pendingApprovalsForRun({ includeResolved: true });
    expect(record?.rejectReason).toBe("overpromises a date");
  });
});
