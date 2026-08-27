import type { MemoryFact } from "../memory/store";

export type TriageInput = {
  channelName: string;
  customerSlug: string;
  message: { user_id: string | null; text: string; permalink: string | null };
  thread: { user_id: string | null; text: string }[];
  recall: MemoryFact[];
};

/**
 * Deliberately says nothing about kinds of ticket. Triage adjudicates one
 * question — does this deserve a human-grade response from us right now —
 * and writes the opening prompt. What kind of thing it is, is the agent's
 * problem. See spec §4.3.
 */
export const TRIAGE_SYSTEM = `You triage messages from a customer Slack channel for a small engineering team.
Decide whether this message needs the team to act or respond (wake=true), or is banter, acknowledgment, an emoji-level reaction, or something already being handled in-thread (wake=false).
Most messages do not need action. Questions, requests, and reports of something broken do.
A direct question from the customer is wake=true even when the answer is obvious or already known to us. Knowing the answer is not the same as the customer having received it; a question counts as handled only if a reply to it is already visible in this thread.
If wake is true, write opening_prompt: a concise briefing for the engineer's agent — what the customer said, the thread context that matters, and what we know about this customer. Quote the customer's actual words where the wording matters.
Always explain the decision in one sentence as "why".`;

export function buildTriagePrompt(input: TriageInput): string {
  const thread =
    input.thread.length === 0
      ? "(no earlier messages in this thread)"
      : input.thread
          .map((m) => `${m.user_id ?? "unknown"}: ${m.text}`)
          .join("\n");
  const recall =
    input.recall.length === 0
      ? "(no stored context for this customer)"
      : input.recall.map((f) => `- ${f.fact}`).join("\n");

  return [
    `Channel: #${input.channelName} (customer: ${input.customerSlug})`,
    ``,
    `Thread so far:`,
    thread,
    ``,
    `What memory knows about this customer:`,
    recall,
    ``,
    `New message from ${input.message.user_id ?? "unknown"}:`,
    input.message.text,
  ].join("\n");
}
