import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { orm } from "./client";
import type { ChannelsRow } from "./schema";
import { channels } from "./tables";

export type ChannelMode = "observe" | "live" | "internal";

/**
 * Where `customer_slug` came from, and therefore what it may be trusted for.
 *
 * `derived` — the auto-registrar slugified the Slack channel name. Good enough
 * to be a Zep graph id, which is ours and self-consistent. NOT good enough to
 * be a tenant key: `#ext-acme` derives `ext-acme`, which can collide with a
 * real Supabase tenant that is not this customer.
 *
 * `human` — someone confirmed it through `PATCH /api/channels/:id`. That route
 * is the only writer of this value.
 *
 * See `migrations/0010_channel_slug_source.sql` and `isTenantKeyTrusted`.
 */
export type SlugSource = "derived" | "human";

export type ChannelPolicy = {
  channel_id: string;
  name: string;
  customer_slug: string | null;
  mode: ChannelMode;
  slug_source: SlugSource;
  /** False when the channel is absent from the table. Drives the fail-closed rule. */
  known: boolean;
};

/**
 * Resolve a channel's posting policy. An unmapped channel gets `observe`, which
 * is never postable. Fail closed: the cost of being wrong here is a stray
 * message to a real customer under an engineer's name. See spec §4.4.
 */
export async function getChannelPolicy(
  db: D1Database,
  channelId: string
): Promise<ChannelPolicy> {
  const row = await orm(db)
    .select({
      channel_id: channels.channel_id,
      name: channels.name,
      customer_slug: channels.customer_slug,
      mode: channels.mode,
      slug_source: channels.slug_source,
    })
    .from(channels)
    .where(eq(channels.channel_id, channelId))
    .get();

  if (!row) {
    return {
      channel_id: channelId,
      name: channelId,
      customer_slug: null,
      mode: "observe",
      // Unreachable as a tenant key anyway, since `customer_slug` is null and
      // `isTenantKeyTrusted` requires both. Stated rather than left implicit.
      slug_source: "derived",
      known: false,
    };
  }
  return { ...row, known: true };
}

/** Only `live` channels accept outbound messages. Everything else refuses. */
export function canPost(policy: ChannelPolicy): boolean {
  return policy.known && policy.mode === "live";
}

/**
 * May this channel's `customer_slug` be used as a TENANT KEY?
 *
 * Deliberately narrower than "is there a slug". A slug is a fine Zep graph id
 * the moment it exists, because that graph is ours and a wrong one is
 * recoverable — we would be reading memory nobody wrote. A tenant key is
 * different: `src/supabase/reader.ts` appends it as an unconditional predicate
 * and refuses a model filter on that column, so a slug that happens to match
 * another customer's tenant returns THEIR rows, with no error to notice.
 *
 * A derived slug is a guess made from a Slack channel name. This is the
 * function that stops a guess being spent as a credential.
 */
export function isTenantKeyTrusted(policy: ChannelPolicy): boolean {
  return (
    policy.known &&
    policy.customer_slug !== null &&
    policy.slug_source === "human"
  );
}

/**
 * One customer the host is willing to admit exists.
 *
 * `slug` never leaves the trusted parent as a usable handle — the discovery
 * capability mints an opaque reference for it and returns only a label. There
 * is deliberately no channel id and no mode on this type: a caller cannot leak
 * what it was never given.
 */
export type CustomerMatch = {
  slug: string;
  label: string;
};

/** Hard ceiling on discovery results, applied after any caller-supplied limit. */
export const CUSTOMER_SEARCH_MAX = 10;

/**
 * Search the channel/customer catalog by name.
 *
 * Parameterized `LIKE` with the wildcards supplied by US, around a query whose
 * own `%` and `_` are escaped — otherwise a one-character `%` query enumerates
 * every customer in the system, which is a directory dump wearing a search's
 * clothes. `ESCAPE '\'` is stated explicitly because SQLite has no default
 * escape character.
 *
 * `internal` channels are excluded: they carry no customer, and the org graph
 * is reachable through `scope: "org"` without naming anything.
 *
 * Matching is on `customer_slug` ONLY, never on `name`. Two reasons, and the
 * second is the one that matters: a channel name is a destination identifier
 * that the model is never shown, so matching on it would let a caller probe for
 * channel names by watching which queries return a hit — an inference oracle
 * over exactly the field this layer withholds. It would also be incoherent,
 * since the label returned is the slug, so a name-only hit would come back
 * looking like it matched nothing.
 *
 * Grouped by slug, so a customer with six channels is one result rather than
 * six identical ones — and so the count the model sees is a count of
 * customers, not of channels, which is the only number it can act on.
 */
export async function searchCustomers(
  db: D1Database,
  query: string,
  limit: number
): Promise<CustomerMatch[]> {
  const bounded = Math.min(Math.max(1, Math.floor(limit)), CUSTOMER_SEARCH_MAX);
  const escaped = query.replace(/[\\%_]/g, "\\$&");

  // `LIKE ... ESCAPE` has no builder method — SQLite has no default escape
  // character, so the clause has to be stated. It stays a `sql` fragment with
  // the pattern still bound as a parameter, not interpolated.
  const results = await orm(db)
    .select({
      // `customer_slug AS slug`, and non-null because the WHERE clause says so.
      slug: sql<
        NonNullable<ChannelsRow["customer_slug"]>
      >`${channels.customer_slug}`,
    })
    .from(channels)
    .where(
      and(
        isNotNull(channels.customer_slug),
        ne(channels.mode, "internal"),
        sql`${channels.customer_slug} like ${`%${escaped}%`} escape '\\'`
      )
    )
    .groupBy(channels.customer_slug)
    .orderBy(asc(channels.customer_slug))
    .limit(bounded)
    .all();

  // The label is the slug, not the channel name. A channel name is a
  // destination identifier and the model is never shown one; the slug is the
  // only human-readable customer-level string the catalog holds.
  return results.map((row) => ({ slug: row.slug, label: row.slug }));
}

/**
 * Triage runs on customer channels — both the live ones and the reference ones.
 * Reference traffic is the eval set (spec §4.5); withholding it would mean
 * tuning the triage prompt against messages we wrote ourselves.
 */
export function shouldTriage(policy: ChannelPolicy): boolean {
  return (
    policy.known && policy.customer_slug !== null && policy.mode !== "internal"
  );
}
