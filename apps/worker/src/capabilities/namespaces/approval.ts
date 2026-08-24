import { z } from "zod";

import type { ClassifiedTool } from "../define";
import { CapabilityError } from "../../gateways/errors";
import { auditedCapability, type BindingContext } from "../registry";

/**
 * The one human decision this run can be parked on: whether one proposed
 * customer Slack reply goes out. There is no destination argument anywhere in
 * this namespace — the channel and thread the decision is about are
 * snapshotted from the run's own pinned scope by the port, never chosen here.
 * A capability that let the model name a channel would be a way to escalate
 * into a conversation the model was never scoped to, which is a security
 * defect wearing a convenience's clothes.
 *
 * `escalate` and `withdraw` are classified `control_write` (see
 * `write-guard.ts`), which is NOT gated by shadow or channel policy the way
 * `external_write` is: pausing a shadow run for approval is exactly what a
 * shadow run should be able to do, and a shadow escalation's delivery is
 * suppressed later, not refused here.
 *
 * Both methods talk to `deps.approval` — the `ApprovalPort` — and nothing
 * else. This file never reads or writes D1 or the RunDO's own storage; that
 * belongs to the port's real implementation (a later task), and Task 3's
 * tests run this file against a plain in-memory double of the port.
 */
export function makeApprovalTools(ctx: BindingContext): Record<string, ClassifiedTool> {
  return {
    escalate: auditedCapability(ctx, "approval", "escalate", {
      effect: "control_write",
      description:
        "Park this run for one human decision on one proposed customer Slack reply. Returns immediately; the pause happens when you finish your turn. Escalate when the message is committal, closes a thread, tells a customer no, or could embarrass the engineer whose name is on it. Do NOT escalate clarifying questions or status updates — send those with slack.reply.",
      input: z.strictObject({
        draft: z.string().trim().min(1).max(4000),
        why: z.string().trim().min(1).max(500),
      }),
      output: z.strictObject({
        approvalId: z.string(),
        state: z.literal("pending"),
      }),
      run: async (input) => {
        // Refused HERE, host-side, before the port is ever called — which is
        // what makes this refusal provably pre-upstream rather than merely
        // classified that way. A second `escalate` while one is open costs
        // nothing upstream and leaves no effect-ledger row, because no
        // effect-ledger call is ever made for this namespace.
        if (ctx.deps.approval.openApprovalId() !== null) {
          throw new CapabilityError(
            "approval_already_open",
            "an approval is already open for this run. Withdraw it first, or wait for the human decision, before escalating again.",
          );
        }
        const { approvalId } = await ctx.deps.approval.open({
          draft: input.draft,
          why: input.why,
        });
        return { approvalId, state: "pending" as const };
      },
    }),

    withdraw: auditedCapability(ctx, "approval", "withdraw", {
      effect: "control_write",
      description:
        "Retract the open approval, e.g. because the customer's newest message made the draft moot. Loses gracefully: if a human already decided, you get their decision back instead of a withdrawal.",
      // `.default({})` for the same reason `slack.thread` needs it:
      // `ToolDispatcher.call` spreads an empty argument array, so
      // `approval.withdraw()` reaches `execute(undefined)`.
      input: z.strictObject({}).default({}),
      output: z.discriminatedUnion("withdrawn", [
        z.strictObject({ withdrawn: z.literal(true) }),
        z.strictObject({
          withdrawn: z.literal(false),
          decision: z.enum(["approved", "edited", "rejected"]),
        }),
      ]),
      run: async () => {
        // Same host-side pre-check as `escalate`: nothing open means nothing
        // to withdraw, refused before the port is ever called.
        if (ctx.deps.approval.openApprovalId() === null) {
          throw new CapabilityError(
            "approval_not_open",
            "there is no open approval on this run to withdraw.",
          );
        }
        return ctx.deps.approval.withdraw();
      },
    }),
  };
}
