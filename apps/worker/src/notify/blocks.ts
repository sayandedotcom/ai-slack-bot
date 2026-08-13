/**
 * Pure Slack Block Kit payload builders.
 *
 * No I/O, no Slack client, no `Env` — plain functions from plain input to
 * plain objects. `nudgeBlocks` is the engineer DM body posted when an
 * approval has sat pending; `resolvedBlocks` is what `chat.update` replaces
 * that message with once a decision lands. The orchestration that actually
 * sends/updates these (retry, dedupe, `chat.postMessage` vs `chat.update`)
 * lives in `src/notify/nudge.ts`, a later task — this file only shapes the
 * payload.
 */

const DRAFT_PREVIEW_LIMIT = 300;
const TRUNCATION_MARKER = "… [truncated]";

function truncateDraft(draft: string): string {
  if (draft.length <= DRAFT_PREVIEW_LIMIT) return draft;
  return draft.slice(0, DRAFT_PREVIEW_LIMIT) + TRUNCATION_MARKER;
}

export function nudgeBlocks(input: {
  draft: string;
  why: string;
  approvalId: string;
  dashboardUrl: string;
  channelName: string;
}): object[] {
  const { draft, why, approvalId, dashboardUrl, channelName } = input;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `Waiting on you: reply to #${channelName}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Why:* ${why}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `> ${truncateDraft(draft)}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Review", emoji: true },
          url: `${dashboardUrl}/?approval=${approvalId}`,
        },
      ],
    },
  ];
}

const RESOLVED_LABEL: Record<"approved" | "edited" | "rejected" | "withdrawn", string> = {
  approved: "Approved",
  edited: "Edited and approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export function resolvedBlocks(input: {
  decision: "approved" | "edited" | "rejected" | "withdrawn";
  decidedBy: string | null;
}): object[] {
  const { decision, decidedBy } = input;
  const label = RESOLVED_LABEL[decision];
  const text = decidedBy ? `${label} by ${decidedBy}` : label;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}
