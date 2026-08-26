import type { ShadowPair } from "../api/shadow";

const now = Date.now();

/**
 * Draft-versus-human pairs from shadow mode: what the agent would have said
 * next to what a fire-fighter actually said. This is a review corpus, not a
 * queue — nobody is waiting on it, which is why it sits below the fold.
 */
export const demoShadowPairs: ShadowPair[] = [
  {
    approvalId: "apr-shadow-4c19",
    draft:
      "Great question! Let me summarise where we are:\n• The export endpoint is rate limited\n• The limit is 60 requests per minute per token\n• We can look at raising it for you\nHope that helps!",
    why: "Answers a question about export limits.",
    createdAt: now - 3 * 60 * 60 * 1000,
    channelId: "C0MACROSNAP",
    threadTs: "1787701122.000200",
    tells: ["great_question", "bulleted_recap", "closing_restatement", "exclamation"],
    humanReply: {
      text: "60 req/min per token. Raising it for your account is possible but needs platform to sign off — I'll ask today.",
      permalink: "https://zellify.slack.com/archives/C0MACROSNAP/p1787701199000200",
      ts: "1787701199.000200",
    },
  },
  {
    approvalId: "apr-shadow-9e02",
    draft:
      "Thanks so much for flagging this! We've rolled back the deploy behind this morning's 502s — no data was affected; we'll send a written post-mortem by Friday.",
    why: "Commits to a post-mortem on a named day.",
    createdAt: now - 7 * 60 * 60 * 1000,
    channelId: "C0PULSEFIT",
    threadTs: "1787688300.000700",
    tells: ["exclaimed_thanks", "semicolon", "em_dash"],
    humanReply: {
      text: "Rolled back. No data affected. Post-mortem to you by Friday.",
      permalink: "https://zellify.slack.com/archives/C0PULSEFIT/p1787688401000700",
      ts: "1787688401.000700",
    },
  },
];
