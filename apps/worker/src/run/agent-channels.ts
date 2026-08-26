/**
 * Where a turn's final text goes, expressed as a Think channel rather than as a
 * sentence in the prompt.
 *
 * The rule this encodes is spec §5's: on a Slack-woken run the model's final
 * text is INTERNAL narration for the engineer watching, and the only thing that
 * reaches a customer is a successful `slack.reply` capability call. On a chat
 * run the final text IS the answer.
 *
 * WHY A CHANNEL AND NOT A PROMPT LINE. A `kind: "custom"` channel with websocket
 * ingress has no out-of-turn delivery surface, so Think has nowhere to deliver a
 * final message except the transcript — `deliverNotice` to it throws. The
 * property is therefore structural: the harness cannot post to Slack even if a
 * future prompt edit told it to. `kind: "web"` is the visible surface, and
 * "web" is reserved by Think for the built-in chat socket (it refuses any other
 * kind under that id).
 *
 * `instructions(ctx)` is re-evaluated per turn (`think.js:2657`) and prepended
 * to the assembled system prompt, which is the one place a per-turn string may
 * live besides `beforeTurn`.
 */
import type { ChannelContext, ThinkChannels } from "@cloudflare/think";

/** The two surfaces a run can be woken on. `web` is Think's reserved chat id. */
export type RunChannelId = "slack" | "web";

/**
 * How the final text is treated. Named rather than boolean so the Slack case
 * reads as what it is at every call site.
 */
export type DeliveryLabel = "internal_narration" | "visible";

export function deliveryLabel(channelId: RunChannelId): DeliveryLabel {
  return channelId === "slack" ? "internal_narration" : "visible";
}

/**
 * Steps one turn may take on either surface.
 *
 * Think's own default is 10, which is low for a run that has to reproduce a bug
 * and open a pull request. Forty is the reviewed ceiling the deleted loop
 * settled on: at the ~$0.068 per step these runs bill, forty steps is ~$2.70,
 * comfortably under the spend ceiling, so the MONEY is the binding authority
 * (invariant 28) rather than a step count that makes the ceiling unreachable.
 */
export const MAX_STEPS_PER_TURN = 40;

const SLACK_INSTRUCTIONS = [
  "## Delivery on this turn",
  "",
  "This run was woken by a Slack thread. Your final text is internal narration",
  "for the engineer watching the run, and no customer will ever see it. The only",
  "words that reach the customer are the ones a successful `slack.reply` call",
  "sends, or a draft a human approves.",
  "",
  "So: do not write your final message as though it were the reply, and do not",
  "assume the customer read anything you did not send.",
].join("\n");

const WEB_INSTRUCTIONS = [
  "## Delivery on this turn",
  "",
  "This run was opened by an engineer on the dashboard. Your final text is shown",
  "to them directly and is the answer. There is no customer on this surface, and",
  "no ambient customer scope: reach one only through an explicit reference you",
  "resolved this turn.",
].join("\n");

/**
 * The channel registry. Both are websocket-ingress: a run is woken by the
 * Worker through RPC, never by a channel's own webhook, so neither declares a
 * messenger.
 */
export const RUN_CHANNELS: ThinkChannels = {
  slack: {
    kind: "custom",
    ingress: { transport: "websocket" },
    instructions: (_ctx: ChannelContext) => SLACK_INSTRUCTIONS,
    maxTurns: MAX_STEPS_PER_TURN,
  },
  web: {
    kind: "web",
    ingress: { transport: "websocket" },
    instructions: (_ctx: ChannelContext) => WEB_INSTRUCTIONS,
    maxTurns: MAX_STEPS_PER_TURN,
  },
};

/** The channel a run of this origin is woken on. One mapping, one place. */
export function channelForOrigin(origin: "slack" | "chat"): RunChannelId {
  return origin === "slack" ? "slack" : "web";
}
