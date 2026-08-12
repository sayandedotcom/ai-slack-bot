import { canPost, getChannelPolicy } from "../db/channels";
import { getRunById } from "../run/repository";
import type { CodeModeScope } from "./contracts";
import { CapabilityError } from "./errors";

/**
 * How a capability changes the world. MANDATORY on every capability, with no
 * default anywhere in this file or in `defineCapability` (invariant 38).
 *
 * A default is what makes a guard decorative. If an unclassified method fell
 * back to `read`, the very next namespace someone adds would post to a customer
 * from a shadow run and nothing would say so — the failure would be invisible
 * precisely because the classification was invisible. So the type has no
 * fallback member, `auditedCapability` requires the field, and
 * `assertClassified` refuses to build a registry containing a method without
 * one. Forgetting is a construction failure, not a silent bypass.
 *
 *  - `read`           — observes; may hit a vendor, changes nothing there.
 *  - `external_write` — mutates something outside this system that a customer
 *                       or a colleague can see: a Slack message, a Linear
 *                       issue, a published artifact.
 *  - `control_write`  — mutates this system's own control state (Phase 11's
 *                       `escalate`/`withdraw`). NOT gated by shadow or channel
 *                       policy: pausing a shadow run for approval is exactly
 *                       what a shadow run should be able to do. It carries its
 *                       own run-state authorization, which Phase 11 builds.
 */
export const CAPABILITY_EFFECTS = ["read", "external_write", "control_write"] as const;

export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

export function isCapabilityEffect(value: unknown): value is CapabilityEffect {
  return (CAPABILITY_EFFECTS as readonly unknown[]).includes(value);
}

/**
 * What the guard needs: one D1 handle.
 *
 * Structural, so `CapabilityDependencies` satisfies it and the call site passes
 * the whole thing. The narrowing is about INTENT rather than reachability — it
 * says this check consults policy rows and nothing else, and it means a future
 * edit that wanted a vendor client here would have to widen this type in a diff
 * somebody reads. It is deliberately not `Env`.
 */
export type WriteGuardDeps = {
  db: D1Database;
};

/**
 * The one host check in front of every side-effecting capability.
 *
 * Every namespace, not just Slack. Phase 09 put the shadow/channel matrix
 * inside `slack.reply` alone, which meant a shadow run could still file a
 * Linear issue and publish an artifact to the app's origin — writes a customer
 * and a colleague can both see. The matrix belongs to the *effect class*, not
 * to one vendor, so it lives here and `auditedCapability` calls it for anything
 * classified `external_write`.
 *
 * Order matters, and it is the shipped Phase 09 order so the model keeps
 * receiving the same code for the same situation:
 *
 *  1. is there anywhere to send?   → slack_context_required (Slack origin only)
 *  2. does the destination accept? → channel_read_only      (Slack origin only)
 *  3. is this run allowed to act?  → shadow_write_denied
 *
 * Both rows are read from D1 HERE, immediately before the write, rather than
 * captured when the run was composed. A channel switched to `observe` mid-run,
 * or a run flipped to shadow by an operator, must stop the next write — not the
 * next run. That costs two reads per external write, which is the correct
 * trade against a message a human decided should not be sent.
 *
 * A missing `runs` row refuses. An unconfirmable run is not a permitted one.
 */
export async function assertExternalWritePermitted(
  deps: WriteGuardDeps,
  scope: CodeModeScope,
): Promise<void> {
  if (scope.origin === "slack") {
    const target = scope.slackThread;
    if (target === null) {
      throw new CapabilityError(
        "slack_context_required",
        "this run is not attached to a conversation, so there is nowhere to act.",
      );
    }

    // `canPost` is already `known && mode === "live"`, and an unmapped channel
    // resolves to `{ mode: "observe", known: false }`. The fail-closed default
    // is inherited from the shipped policy code, not reimplemented here.
    const policy = await getChannelPolicy(deps.db, target.channelId);
    if (!canPost(policy)) {
      throw new CapabilityError(
        "channel_read_only",
        `this conversation is not live (mode=${policy.mode}), so nothing outside this system was changed. Report what you would have done instead.`,
      );
    }
  }

  // Read shadow from D1, NOT from the run descriptor. RunState has no `shadow`
  // field; a check written against the descriptor reads undefined, which is
  // falsy, and the run writes. This is the single most dangerous wrong
  // assumption available in this phase, so it is a database read.
  const record = await getRunById(deps.db, scope.runId);
  if (record === null || record.shadow) {
    throw new CapabilityError(
      "shadow_write_denied",
      record === null
        ? "this run could not be confirmed as permitted to act; nothing was changed."
        : "this run is observing only; nothing was changed. Report what you would have done.",
    );
  }
}

/**
 * Apply the matrix for one classified capability.
 *
 * `read` and `control_write` pass through. That is not laxity: read-only
 * investigation must stay available in a shadow run — evaluating a draft is the
 * entire point of shadow — and control writes answer to Phase 11's run-state
 * authority rather than to channel policy.
 */
export async function assertEffectPermitted(
  deps: WriteGuardDeps,
  scope: CodeModeScope,
  effect: CapabilityEffect,
): Promise<void> {
  if (effect !== "external_write") return;
  await assertExternalWritePermitted(deps, scope);
}
