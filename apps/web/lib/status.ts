import type { BadgeTone } from "@workspace/ui/components/status-badge";

import type { Decision } from "./api/approvals";
import type { RunStatus } from "./api/runs";
import type { AiTell } from "./api/shadow";
import { TELL_MEANING } from "./api/shadow";

export type BadgeSpec = {
  tone: BadgeTone;
  label: string;
  pulse?: boolean;
  /** One sentence for the tooltip: what it means for the reader, not the schema. */
  meaning: string;
};

const RUN: Record<RunStatus, BadgeSpec> = {
  live: {
    tone: "attention",
    label: "live",
    pulse: true,
    meaning: "The agent is working on this thread right now.",
  },
  awaiting_approval: {
    tone: "attention",
    label: "needs you",
    meaning: "The agent has drafted a reply and is waiting on a human.",
  },
  idle: {
    tone: "neutral",
    label: "idle",
    meaning:
      "Woken, then nothing further to do — it resumes if the thread moves.",
  },
  done: {
    tone: "success",
    label: "done",
    meaning: "Finished; the thread was answered or closed.",
  },
  failed: {
    tone: "destructive",
    label: "failed",
    meaning: "The run stopped on an error and did not recover.",
  },
};

export function runStatusBadge(status: RunStatus): BadgeSpec {
  return RUN[status];
}

export function originBadge(origin: string): BadgeSpec {
  return origin === "chat"
    ? {
        tone: "neutral",
        label: "chat",
        meaning: "Started from the dashboard, not a customer thread.",
      }
    : {
        tone: "neutral",
        label: origin,
        meaning: "Woken by a message in a Slack channel.",
      };
}

export const SHADOW_BADGE: BadgeSpec = {
  tone: "shadow",
  label: "shadow",
  meaning:
    "Shadow run — it drafts and reasons, but nothing it does reaches a customer.",
};

export function connectBadge(
  connected: boolean,
  provider: "slack" | "github"
): BadgeSpec {
  const name = provider === "slack" ? "Slack" : "GitHub";
  return connected
    ? {
        tone: "success",
        label: `${name} connected`,
        meaning: `${name} is authorised under this person's own account.`,
      }
    : {
        tone: "neutral",
        label: `${name} not connected`,
        meaning: `Until ${name} is connected the agent cannot act as this person there.`,
      };
}

const DECISION: Record<Decision, BadgeSpec> = {
  pending: {
    tone: "attention",
    label: "waiting",
    meaning: "Nobody has decided this yet.",
  },
  approved: { tone: "success", label: "approved", meaning: "Sent as drafted." },
  edited: {
    tone: "info",
    label: "edited",
    meaning: "Sent with a human's changes.",
  },
  rejected: {
    tone: "destructive",
    label: "rejected",
    meaning: "Not sent; the agent was told why.",
  },
  withdrawn: {
    tone: "neutral",
    label: "withdrawn",
    meaning: "The agent took the ask back before anyone decided.",
  },
};

export function decisionBadge(decision: Decision): BadgeSpec {
  return DECISION[decision];
}

export function tellBadge(tell: AiTell): BadgeSpec {
  return {
    tone: "warning",
    label: tell.replaceAll("_", " "),
    meaning: TELL_MEANING[tell],
  };
}

const EFFECT: Record<
  "reserved" | "completed" | "failed" | "in_doubt",
  BadgeSpec
> = {
  reserved: {
    tone: "neutral",
    label: "reserved",
    meaning: "Claimed in the ledger; the call has not returned.",
  },
  completed: {
    tone: "success",
    label: "completed",
    meaning: "The call returned and its result was recorded.",
  },
  failed: {
    tone: "destructive",
    label: "failed",
    meaning: "The call failed and nothing reached the outside world.",
  },
  in_doubt: {
    tone: "warning",
    label: "in doubt",
    meaning:
      "The call was made but its outcome may or may not have been recorded.",
  },
};

export function effectStateBadge(state: keyof typeof EFFECT): BadgeSpec {
  return EFFECT[state];
}
