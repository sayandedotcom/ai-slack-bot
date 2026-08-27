# Generic channel registry — design

Date: 2026-08-27. Status: approved in brainstorming, awaiting spec review.
Amends `2026-08-10-firefighter-agent-design.md` §4.4 (channel policy). The
`observe | live | internal` mode enum and the hand-seeded `channels` table are
retired; §4.4's fail-closed property is preserved by different means, stated in
§6 below.

## 1. Context

The channel policy table was built for a trial with a known, tiny channel list:
three rows pasted into `apps/worker/scripts/seed-channels.sh` by hand. Ingest
hears every channel (core requirement 1), but `shouldTriage()` and `canPost()`
both require a row, so a channel nobody seeded is stored and then silently
dropped — never triaged, never answered, with no signal that it happened.

Measured on production on 2026-08-27:

| channel | mode | bot is a member | messages ingested |
| --- | --- | --- | --- |
| `#test-firedrill` | live | yes | 93 (last 2026-08-17) |
| `#ff-test` | live | yes | 0 |
| `#ext-zellify-sidehop` | observe | **no** (`not_in_channel`) | **0** |

Every real message in the system came from one test channel. The product goal
has changed: the deliverable is a generic Slack bot that starts working in any
channel it is invited to, with an unknown and growing number of customer
channels. A human-seeded table cannot express that.

`observe` was not an accident — it encoded a read-only arrangement with one
real customer (Sidehop). That constraint is real and survives this design as
data, not as code.

## 2. Goals and non-goals

**Goals.** Zero hardcoded channel identifiers anywhere in the repo. A channel
the bot is invited to is triaged and answerable within seconds, with no
deploy, no script and no human step. Read-only remains expressible, per
channel, from the dashboard. No silent wrong answers when a channel's customer
identity is not yet known.

**Non-goals.** The fire-fighter roster, the pinned GitHub repo and base branch,
the Linear team, the LangSmith read project and the Supabase table allowlist
stay pinned in code. Those are guardrails on what the agent may *touch*, not on
which customers it serves; a new customer channel requires no change to any of
them. Slack Connect / external-workspace modelling is out of scope.

## 3. Decisions

**C1 — Registration is lazy plus reconciled, and needs no new Slack event
subscription.** Two paths write through one `registerChannel()`:

  1. *Lazy.* `handleIngestBatch` already resolves the policy per message. When
     the row is absent, resolve the channel name via `conversations.info` and
     insert before classification continues. Latency is zero for the first
     message from a new channel.
  2. *Reconcile.* A fifth cron sweep beside the existing four calls
     `users.conversations` (`types=public_channel,private_channel`), inserting
     channels nobody has spoken in yet and setting `active = 0` for channels
     the bot has been removed from.

  `member_joined_channel` was rejected: it would change the webhook's envelope
  filter and the `QueuedEvent` shape for a case the reconcile sweep already
  covers, and it does not self-heal a missed delivery. Consequence: Event
  Subscriptions are unchanged; only two scopes are added (§8).

**C2 — `mode` is replaced by three booleans.** `postable`, `triaged`, `active`.
The enum conflated an operator's posting decision, a channel's customer status
and the bot's membership. Two of those are now toggles a human owns and one is
observed fact.

  - `canPost(policy)` becomes `policy.postable && policy.active`.
  - `shouldTriage(policy)` becomes `policy.triaged && policy.active`.
  - `searchCustomers` swaps its `mode != 'internal'` predicate for
    `triaged = 1`, keeping its meaning: a customer is a channel whose traffic
    the agent is asked to act on. Its `GROUP BY customer_slug` already collapses
    a customer's several channels into one result, which is why a shared slug
    across channels is worth editing toward.
  - `observe` is `postable = 0`; `internal` is `triaged = 0`; `live` is both 1.

**C3 — Everything defaults to `postable = 1, triaged = 1`.** Invite is consent.
Predictability beats cleverness: a heuristic keyed on Slack Connect's
`is_ext_shared` would default the team's own `#ff-test` and `#test-firedrill`
to listen-only, which is wrong. An internal channel is demoted with one
dashboard toggle.

  This does not weaken the approval gate. A postable channel means the agent
  may *propose*; every customer-facing send still requires a dashboard approval
  and a connected fire-fighter identity, and goes out under that fire-fighter's
  own Slack name.

**C4 — `customer_slug` is derived, and its provenance is recorded.** The slug
defaults to the slugified channel name and is editable from the dashboard. A
new `slug_source` column holds `'auto'` or `'manual'`.

  This exists because `customer_slug` is not a label. `src/supabase/allowlist.ts`
  uses it as `tenantColumn` — it is injected as the tenant filter into
  Zellify's production database. An auto-derived slug will not match a real
  tenant id, and an unmatched filter returns zero rows, which the agent would
  report as "no data for this customer": a wrong answer indistinguishable from
  a true one.

  Therefore **Supabase reads refuse on `slug_source = 'auto'`** with a
  `customer_unverified` `CapabilityError` naming the dashboard step. Every
  other capability — Slack, memory, Linear, BetterStack, LangSmith, sandbox,
  GitHub — works immediately on an auto slug. Memory graphs key on
  `customer:{slug}` and tolerate an arbitrary but stable slug; they are recall,
  not record, so a later slug edit costs continuity, not correctness.

**C5 — The dashboard owns the toggles.** `GET /api/channels` and
`PATCH /api/channels/:id` (fields: `postable`, `triaged`, `customerSlug`).
Fire-fighters only, mirroring `src/api/approvals.ts:247`; viewers read. A slug
edit sets `slug_source = 'manual'`.

  The write guard already re-reads D1 at call time
  (`src/capabilities/write-guard.ts:44`), so demoting a channel stops the next
  write of a run already in flight. No redeploy, no restart.

**C6 — `scripts/seed-channels.sh` is deleted.** No channel identifier remains
in tracked source.

## 4. Schema

Migration `0010_channels_generic.sql`. SQLite table rebuild rather than
`ALTER TABLE`, because `mode` carries a `NOT NULL` `CHECK` constraint that
auto-registration cannot satisfy. Three production rows; append-only rule is
respected (a new file, no edit to an existing migration).

```sql
CREATE TABLE channels_new (
  channel_id    TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  customer_slug TEXT,
  slug_source   TEXT    NOT NULL DEFAULT 'auto'
                        CHECK (slug_source IN ('auto','manual')),
  postable      INTEGER NOT NULL DEFAULT 1,
  triaged       INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  registered_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO channels_new
  (channel_id, name, customer_slug, slug_source, postable, triaged, active, registered_at)
SELECT channel_id, name, customer_slug, 'manual',
       CASE WHEN mode = 'live'     THEN 1 ELSE 0 END,
       CASE WHEN mode = 'internal' THEN 0 ELSE 1 END,
       1, 0
FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;
```

The backfill preserves the trial's meaning exactly: Sidehop keeps
`postable = 0` (its read-only arrangement, now data), both test channels keep
`postable = 1`, and all three are marked `slug_source = 'manual'` so verified
tenant mappings are not lost.

## 5. Components

| unit | file | responsibility |
| --- | --- | --- |
| policy read/write | `src/db/channels.ts` | `getChannelPolicy`, `canPost`, `shouldTriage`, `searchCustomers`, `listChannels`, `updateChannel` |
| registry | `src/channels/registry.ts` *(new)* | `registerChannel`, `reconcileMembership`, `deriveSlug` |
| Slack lookup | `src/slack/client.ts` | `getConversationInfo`, `listBotConversations` |
| HTTP | `src/api/channels.ts` *(new)* | `GET /api/channels`, `PATCH /api/channels/:id` |
| cron | `src/index.ts` | fifth sweep in the existing `Promise.allSettled` |
| UI | `apps/dashboard/src/channels/` *(new)* | `api.ts`, `channels-panel.tsx` |

`registerChannel` is the single writer for auto-registration; both the lazy
path and the sweep call it, and it is idempotent on `channel_id`
(`INSERT ... ON CONFLICT DO UPDATE` of `name`/`active` only, never of a
human's `postable`, `triaged` or manual slug).

The dashboard gets a panel in the existing `app.tsx` grid, not a route. There
is no router library in this SPA — one hash key is the whole routing need — and
a second navigation concept for one table would be the wrong shape.

## 6. Fail-closed, preserved

Today an unmapped channel refuses because it has no row. After this change the
row is created on first sighting, so the unmapped case shrinks to one race: a
message whose registration has not yet committed. `getChannelPolicy` keeps
returning `known: false` for an absent row, and `canPost` keeps requiring
`known`, so that race refuses to post exactly as before. `active = 0` is a
second closed door: a channel the bot has been removed from is neither
postable nor triaged even though its row survives.

Two properties are unchanged and must stay so: ingest never gates on the
channel table (core requirement 1), and the DM drop in `src/ingest/rules.ts:51`
remains the only guard against DM ingestion regardless of scopes.

## 7. Error handling

| condition | behaviour |
| --- | --- |
| `conversations.info` fails on the lazy path | register with `name = channel_id`; the sweep corrects it. Ingest never fails on a Slack API error. |
| `users.conversations` fails in the sweep | sweep resolves rejected; the other four sweeps are unaffected (`Promise.allSettled`). |
| message arrives before registration commits | `known: false` → not postable, not triaged. The message is still stored. |
| Supabase read on `slug_source = 'auto'` | `CapabilityError("customer_unverified", …)` naming the dashboard step. |
| `PATCH` by a viewer | `403 not_a_firefighter`, before any D1 write. |
| `PATCH` on an unknown channel | `404 unknown_channel`. |

## 8. Slack app configuration (operator)

**Add:** `channels:read`, `groups:read` — required by `conversations.info` and
`users.conversations`. Reinstall the app after the change.

**Remove** (measured unused: a sweep of `src/` finds only `chat.postMessage`,
`chat.update`, `chat.getPermalink`, `conversations.history`,
`conversations.open`): `app_mentions:read`, `reactions:write`, `reactions:read`,
`assistant:write`, `users:read`, `im:history`, `im:read`. Removing the two
`im:*` scopes makes the platform enforce the channels-only rule that one `if`
currently carries alone. `im:write` stays — the approval nudge DM needs
`conversations.open`.

**Unchanged:** Event Subscriptions. Per C1 no new event type is consumed.

**Operator action, separate from this change:** invite the bot to
`#ext-zellify-sidehop`. Its row exists and is correct; the bot is simply not a
member, which is why zero messages have ever arrived from it.

## 9. Testing

Worker: `test/channels-registry.test.ts` (lazy register, idempotence, slug
derivation, human edits survive re-registration, `active` flip on removal),
`test/api-channels.test.ts` (list, patch, fire-fighter gate, unknown id),
extensions to `test/capabilities-write-guard.test.ts` (postable/active
combinations) and `test/capabilities-readers.test.ts` (the
`customer_unverified` refusal).

Nineteen `INSERT INTO channels` sites across thirteen test files are replaced
by one `seedChannel()` helper in `test/helpers/`, so this schema change and any
future one land in a single place.

Dashboard: `channels/api.test.ts` and a panel test asserting the fire-fighter
gate on the toggles.

The gate stays `pnpm test`, `pnpm typecheck` and `pnpm capabilities:dts:check`
in `apps/worker`, plus the dashboard's own `pnpm test`/`pnpm typecheck`.

## 10. Rollout

1. Migration `0010` applied remotely.
2. Deploy. The reconcile sweep registers `#ff-test` and `#test-firedrill`
   within a minute; both already have correct rows, so only `name` and
   `active` are touched.
3. Operator adds the two scopes, removes the seven, reinstalls the app.
4. Operator invites the bot to `#ext-zellify-sidehop`; it registers
   automatically and keeps `postable = 0`.
5. Verification: invite the bot to a fresh channel, post one message, confirm
   a row appears in the dashboard and a run wakes without any manual step.

---

## Implementation log — 2026-08-27

What shipped, and where it departs from the design above.

**Shipped in full.** Auto-registration (C1): lazy on first ingest plus the cron
sweep, no new Slack event subscription, `registerChannel` the only writer.
Proven in production — the only `channels` row was deleted and the sweep
restored it within 45 s, and a second channel registered itself and produced a
full run.

**Shipped, in the narrower form.** The `slug_source` guard (C4). This is the
half that mattered: `customer_slug` is spent as an unconditional Supabase
tenant predicate, so a slug derived from a channel name can collide with a real
tenant and return that customer's rows with no error to notice. Implemented as
`slug_source TEXT NOT NULL DEFAULT 'derived'` (migration `0010`),
`isTenantKeyTrusted()`, `RunScope.customerSlugTrusted`, and a distinct
`customer_scope_unverified` capability error. The chosen policy — "refuse
Supabase, everything else works" — is enforced at exactly one point, the tenant
predicate in `src/supabase/reader.ts`, and the refusal happens BEFORE the
request so the tenant value is never sent upstream.

`DEFAULT 'derived'` applies to every pre-existing row. That is deliberate and
fails closed: the rows in production today were written by the auto-registrar,
so 'derived' is also the truth.

**NOT shipped, deliberately deferred.** The `mode` -> `postable`/`triaged`/
`active` boolean split (C2). It is a table rebuild plus a wider dashboard
surface, and since the design defaults all three booleans to on, it changes NO
behaviour today — it is ergonomics, not safety. `mode` is unchanged, and
`PATCH /api/channels/:id` sets it directly, which is enough to demote a channel
without SQL. Revisit when someone actually wants "triaged but never postable"
as a standing state rather than as `observe`.

**Added, not in the design.** `GET /api/channels` and the dashboard
`ChannelsPanel`. The design assumed the dashboard owned the toggles (C5) but
did not specify the surface. Reading is any rostered member; writing is
fire-fighters only, checked before the body is parsed or D1 is touched — the
same ordering as `PATCH /api/approvals/:id`. The route deliberately cannot
create or delete a channel: registration derives the name from Slack, and an
upsert here would mint a row whose name nobody has confirmed exists.

Covered by `test/channels-slug-source.test.ts` (17 cases), including the two
that matter most: the refusal fires before any outbound fetch, and a read whose
allowlist entry has no `tenantColumn` is left alone.
