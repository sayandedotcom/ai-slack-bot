"use client";

import { useSearchParams } from "next/navigation";

/**
 * The approval a Slack nudge deep-linked to, or `null`.
 *
 * `apps/worker/src/notify/blocks.ts` builds every approval DM's Review button
 * as `${DASHBOARD_BASE_URL}/?approval=<id>`, so this parameter is the only
 * thing connecting a notification to the card it is about. Before this existed
 * the button landed on a dashboard that ignored it, which reads as a dead link
 * at exactly the moment somebody is being paged.
 *
 * Read-only, unlike `useSelectedRun`. Nothing in this app writes the parameter
 * and nothing clears it: the URL that arrived from Slack is the URL that stays,
 * so a reload lands where the link pointed rather than somewhere else.
 */
export function useSelectedApproval(): string | null {
  return useSearchParams().get("approval");
}

/**
 * The DOM id of one approval's card. Shared so the queue's scroll and the
 * card's own attribute cannot drift apart.
 */
export function approvalDomId(approvalId: string): string {
  return `approval-${approvalId}`;
}

/**
 * Which approval, if any, should be scrolled to right now.
 *
 * Pure, and separate from the effect that acts on it, because the rule worth
 * getting right is a timing rule rather than a rendering one: the queue polls
 * every three seconds (`POLL_MS.approvals`), so an effect that merely depended
 * on the card list would re-scroll the page under the reader on every tick.
 * `alreadyFocused` is what makes it fire once per id.
 *
 * Returns `null` when the id is absent from the queue — a card that was already
 * decided is not in the open list, and scrolling to nothing is not an error.
 */
export function nextApprovalFocus(input: {
  requested: string | null;
  alreadyFocused: string | null;
  present: readonly string[];
}): string | null {
  const { requested, alreadyFocused, present } = input;
  if (requested === null) return null;
  if (requested === alreadyFocused) return null;
  if (!present.includes(requested)) return null;
  return requested;
}
