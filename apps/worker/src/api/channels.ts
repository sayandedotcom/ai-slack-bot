/**
 * The human control surface over the channel registry.
 *
 * Channels register themselves now (`src/channels/registry.ts`): the bot is
 * invited, the first message registers the channel, and the cron sweep picks up
 * anything quiet. That is deliberate — with an unknown and growing number of
 * customer channels, a hand-seeded table is a bot that mostly does not work.
 *
 * But auto-registration writes two values it cannot actually know:
 *
 *  - `mode`, which defaults to `live`. Invite is consent, and that is the right
 *    default, but there was no way to take it back short of writing SQL against
 *    production D1.
 *  - `customer_slug`, slugified from the Slack channel name. Fine as a Zep graph
 *    id, which is ours. NOT fine as a Supabase tenant key, which is what
 *    `src/supabase/reader.ts` spends it as — see `isTenantKeyTrusted`.
 *
 * This module is where a human corrects both. It is the ONLY writer of
 * `slug_source = 'human'`; nothing else in the codebase produces that value, so
 * "a human confirmed this" means exactly "somebody called this route".
 *
 * AUTHORIZATION. Reading is any rostered team member. Writing is fire-fighters
 * only, the same bar as deciding an approval — because both `mode` and
 * `customer_slug` decide what the agent may say and whose data it may read.
 * Both gates are the INNER half; Cloudflare Access is the outer one, and
 * neither is skippable.
 */
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ChannelMode } from "../db/channels";
import { orm } from "../db/client";
import type { ChannelsRow } from "../db/schema";
import { channels } from "../db/tables";
import type { Env } from "../index";
import { requireTeamMember } from "./identity";

export const channelsApi = new Hono<{ Bindings: Env }>();

const MODES: readonly ChannelMode[] = ["observe", "live", "internal"];

/**
 * Hard ceiling on a listing. A workspace can hold thousands of channels and
 * this response goes to a browser; there is no pagination because the dashboard
 * panel is a control surface, not a directory.
 */
const LIST_LIMIT = 200;

function fail(code: string, message: string) {
  // Code and a generic reason only — these cross to the browser.
  return { code, message };
}

/**
 * What the dashboard is shown.
 *
 * `slug_source` crosses deliberately: without it the panel cannot distinguish
 * "this customer was confirmed" from "this is a guess off the channel name",
 * which is the single thing an operator is here to fix.
 */
function publicChannel(row: ChannelsRow) {
  return {
    channelId: row.channel_id,
    name: row.name,
    customerSlug: row.customer_slug,
    mode: row.mode,
    slugSource: row.slug_source,
  };
}

channelsApi.get("/channels", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const results = await orm(c.env.DB)
    .select({
      channel_id: channels.channel_id,
      name: channels.name,
      customer_slug: channels.customer_slug,
      mode: channels.mode,
      slug_source: channels.slug_source,
    })
    .from(channels)
    .orderBy(asc(channels.name))
    .limit(LIST_LIMIT)
    .all();

  return c.json({ channels: results.map(publicChannel) });
});

/**
 * What a `PATCH` body may carry. Both fields optional, at least one required.
 *
 * `customerSlug` accepts a string or `null` — null detaches the channel from a
 * customer entirely, which is the honest answer for an internal channel that
 * auto-registered with a slug derived from its name.
 */
type ChannelPatch = {
  mode?: ChannelMode;
  customerSlug?: string | null;
};

/**
 * Parse and validate, returning `null` on anything malformed.
 *
 * The slug is constrained to the same shape `deriveSlug` produces. Not
 * cosmetic: it goes into a PostgREST query value as a tenant predicate and into
 * a Zep graph id, so accepting arbitrary text here would mean trusting two
 * downstream encoders to be perfect forever.
 */
function parsePatch(body: unknown): ChannelPatch | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const record = body as Record<string, unknown>;
  const patch: ChannelPatch = {};

  if ("mode" in record) {
    const mode = record.mode;
    if (typeof mode !== "string" || !MODES.includes(mode as ChannelMode))
      return null;
    patch.mode = mode as ChannelMode;
  }

  if ("customerSlug" in record) {
    const slug = record.customerSlug;
    if (slug === null) {
      patch.customerSlug = null;
    } else if (
      typeof slug === "string" &&
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
      slug.length <= 100
    ) {
      patch.customerSlug = slug;
    } else {
      return null;
    }
  }

  return patch.mode === undefined && patch.customerSlug === undefined
    ? null
    : patch;
}

/**
 * The one writer surface for channel policy.
 *
 * Fire-fighters only, checked BEFORE the body is parsed or D1 is touched, so a
 * viewer's request leaves no trace — the same ordering as
 * `PATCH /api/approvals/:id`.
 *
 * Setting `customerSlug` is what promotes `slug_source` to `'human'`, and it is
 * set in the SAME statement, so there is no window in which the new slug is
 * live while still marked derived. Clearing it to `null` sends the row back to
 * `'derived'`: nothing is confirmed any more, so the Supabase refusal comes
 * back on. A `mode`-only patch touches neither.
 *
 * Note what this route deliberately CANNOT do: create a channel or delete one.
 * Registration is the registrar's job, and a channel the bot was removed from
 * keeps its row — Slack itself refuses the post with `not_in_channel`, which is
 * a better enforcement point than a row we would have to keep in sync.
 */
channelsApi.patch("/channels/:id", async (c) => {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;
  if (member.role !== "firefighter") {
    return c.json(
      fail("not_a_firefighter", "channel policy is fire-fighters only"),
      403
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail("invalid_patch", "body must be JSON"), 422);
  }

  const patch = parsePatch(body);
  if (patch === null) {
    return c.json(
      fail(
        "invalid_patch",
        "send mode (observe|live|internal) and/or customerSlug (a lowercase slug, or null). At least one is required."
      ),
      422
    );
  }

  // A partial update, built as an object rather than as a `SET` fragment list
  // and a parallel bind array. The two used to be kept in step by hand, and
  // `slug_source` is exactly the column where that going wrong is a security
  // bug rather than a rendering one.
  const sets: Partial<typeof channels.$inferInsert> = {};
  if (patch.mode !== undefined) sets.mode = patch.mode;
  if (patch.customerSlug !== undefined) {
    // The slug and its provenance move together, always. Splitting them into
    // two statements would leave a window where an unconfirmed slug is already
    // being spent as a tenant key.
    sets.customer_slug = patch.customerSlug;
    sets.slug_source = patch.customerSlug === null ? "derived" : "human";
  }

  const [updated] = await orm(c.env.DB)
    .update(channels)
    .set(sets)
    .where(eq(channels.channel_id, c.req.param("id")))
    .returning({
      channel_id: channels.channel_id,
      name: channels.name,
      customer_slug: channels.customer_slug,
      mode: channels.mode,
      slug_source: channels.slug_source,
    });

  // No row means the channel has never been seen. Deliberately NOT an upsert:
  // registration derives the name from Slack, and inventing a row here would
  // mint a channel whose `name` nobody has confirmed exists.
  if (updated === undefined) {
    return c.json(
      fail(
        "unknown_channel",
        "no such channel. It registers itself once the bot is invited and sees a message, or within a minute via the cron sweep."
      ),
      404
    );
  }

  return c.json(publicChannel(updated));
});
