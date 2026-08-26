import type { ChatThread } from "../api/chat";

/**
 * The second door: a viewer asking the same agent Slack wakes, and handing it
 * work directly. Marcus is a viewer — not an engineer, not on the rotation —
 * and this page is his whole interface.
 */
export const demoChatThread: ChatThread = {
  title: "Marcus ↔ Firefighter",
  messages: [
    {
      id: "m1",
      author: "user",
      name: "Marcus",
      role: "viewer",
      at: "15:02",
      text: "did PulseFit complain about checkout before this week? what did we do back then?",
    },
    {
      id: "m2",
      author: "agent",
      name: "Firefighter",
      role: "agent",
      at: "15:02",
      text: "Twice, both resolved. Jul 28 they hit a currency-rounding bug ($9.999 on the annual plan) — fixed same day in #1287. Jul 12 a webhook retry double-counted a renewal; we added dedupe and credited them manually. Today's Android tap issue is unrelated to either; the fix is in review.",
      citations: [
        {
          channelName: "zellify-pulsefit",
          day: "Jul 28",
          quote: "annual shows $9.999??",
          outcome: "resolved in 4h",
          permalink: "https://zellify.slack.com/archives/C0PULSEFIT/p1785283200000100",
        },
        {
          channelName: "zellify-pulsefit",
          day: "Jul 12",
          quote: "renewal double-count",
          outcome: "dedupe + manual credit",
          permalink: "https://zellify.slack.com/archives/C0PULSEFIT/p1783900800000300",
        },
      ],
    },
    {
      id: "m3",
      author: "user",
      name: "Marcus",
      role: "viewer",
      at: "15:04",
      text: "nice — file a Linear issue to track the Android fix rollout, and make sure it gets a changelog entry",
    },
    {
      id: "m4",
      author: "agent",
      name: "Firefighter",
      role: "agent",
      at: "15:04",
      text: "Filed ZEL-2044 (\"Track Android WebView fix rollout\") and drafted the changelog entry as a PR that links it — review it on GitHub; the issue closes itself on merge.",
      toolCalls: [
        { name: "linear.create", detail: "ZEL-2044" },
        { name: "files.search", detail: "changelog format" },
        { name: "github.pr", detail: "changelog draft" },
      ],
    },
  ],
  suggestions: [
    "what shipped for customers this week?",
    "which customer is angriest right now and why?",
    "ship the copy-funnel-ID button Priya asked for",
    "summarise Driftwear's big ask for Monday's standup",
  ],
};
