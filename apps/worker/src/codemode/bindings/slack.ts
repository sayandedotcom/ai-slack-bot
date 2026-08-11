import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { auditedCapability, type BindingContext } from "../registry";

const message = z.strictObject({
  ts: z.string(),
  userId: z.string().nullable(),
  text: z.string(),
  permalink: z.string().nullable(),
});

/**
 * `.default({})` is load-bearing, not tidiness. `ToolDispatcher.call` spreads an
 * empty argument array, so a model writing `slack.thread()` reaches
 * `execute(undefined)`. Without the default that is a validation failure on a
 * call the generated types never told it was wrong. The type teaches `{}`; the
 * default tolerates its absence.
 */
const threadInput = z
  .strictObject({ limit: z.number().int().min(1).max(200).optional() })
  .default({});

export function makeSlackTools(ctx: BindingContext): ToolDescriptors {
  return {
    thread: auditedCapability(ctx, "slack", "thread", {
      description:
        "Read the messages of the conversation this run belongs to, oldest first.",
      input: threadInput,
      output: z.array(message),
      run: async (input) => ctx.deps.slack.thread(input.limit ?? 50),
    }),

    searchMessages: auditedCapability(ctx, "slack", "searchMessages", {
      // Named searchMessages, not search: generated type aliases carry no
      // namespace prefix, so a second `search` elsewhere would emit a duplicate
      // `type SearchInput` and the joined declarations would not compile.
      description:
        "Search previously ingested messages within the scope this run already has.",
      input: z.strictObject({
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: z.array(message),
      run: async (input) =>
        ctx.deps.slack.searchMessages(input.query, input.limit ?? 20),
    }),

    reply: auditedCapability(ctx, "slack", "reply", {
      // No destination argument, deliberately. Where a reply lands is a
      // property of the run, decided by the host before this code ever ran.
      description:
        "Post a reply into the conversation this run belongs to. The destination is fixed by the run and cannot be chosen here.",
      input: z.strictObject({ text: z.string().min(1).max(4000) }),
      output: z.strictObject({
        ts: z.string(),
        permalink: z.string().nullable(),
      }),
      run: async (input) => ctx.deps.slack.reply(input.text, ctx.scope.turnId),
    }),
  };
}
