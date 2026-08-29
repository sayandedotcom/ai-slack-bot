import { and, eq } from "drizzle-orm";
import { FIREFIGHTERS, VIEWERS } from "../access/roster";
import { orm } from "./client";
import type { IdentitiesRow } from "./schema";
import { identities } from "./tables";

/**
 * D1-only operations on `identities` (`migrations/0008_identities.sql`): which
 * roster member has connected which provider, and the sealed token to act as
 * them.
 *
 * `tokenCiphertext` is an OPAQUE STRING here. This module does no crypto — it
 * neither seals nor opens, and never inspects the value it stores. Keeping the
 * key material out of the storage layer is what lets the crypto module stay the
 * one place a plaintext token can exist.
 *
 * The roster is the spine, D1 only decorates: `listConnectStatus` starts from
 * `FIREFIGHTERS`/`VIEWERS` and asks D1 only what has been connected. A stale or
 * orphaned `identities` row for someone who left the roster therefore cannot
 * conjure a person into the dashboard.
 */

export type Provider = "slack" | "github";

export type IdentityRow = {
  email: string;
  provider: Provider;
  externalId: string;
  scopes: string;
  /** Sealed by the crypto module. Opaque to everything in this file. */
  tokenCiphertext: string;
  connectedAt: number;
  updatedAt: number;
};

/** One roster member's connect state, for the dashboard. Never carries a token. */
export type ConnectStatus = {
  email: string;
  role: "firefighter" | "viewer";
  slack: boolean;
  github: boolean;
};

type IdentityRowDb = IdentitiesRow;

function toRow(db: IdentityRowDb): IdentityRow {
  return {
    email: db.email,
    provider: db.provider,
    externalId: db.external_id,
    scopes: db.scopes,
    tokenCiphertext: db.token_ciphertext,
    connectedAt: db.connected_at,
    updatedAt: db.updated_at,
  };
}

/**
 * Record a completed OAuth connect. Re-connecting the same provider (a fresh
 * consent, a rotated token, a widened scope set) overwrites the existing row
 * rather than erroring or accumulating history: the current credential is the
 * only one anyone can act with, so there is nothing to keep. `now` is required,
 * never defaulted — same discipline as `src/approval/repository.ts`.
 */
export async function upsertIdentity(
  db: D1Database,
  row: Omit<IdentityRow, "updatedAt">,
  now: number
): Promise<void> {
  const values = {
    email: row.email,
    provider: row.provider,
    external_id: row.externalId,
    scopes: row.scopes,
    token_ciphertext: row.tokenCiphertext,
    connected_at: row.connectedAt,
    updated_at: now,
  };
  await orm(db)
    .insert(identities)
    .values(values)
    .onConflictDoUpdate({
      target: [identities.email, identities.provider],
      // Every column except the conflict target itself, which is what the
      // hand-written statement bound a second time. `email`/`provider` are
      // excluded because updating a row's key to the value it already has is
      // noise, not an update.
      set: {
        external_id: values.external_id,
        scopes: values.scopes,
        token_ciphertext: values.token_ciphertext,
        connected_at: values.connected_at,
        updated_at: values.updated_at,
      },
    })
    .run();
}

export async function getIdentity(
  db: D1Database,
  email: string,
  provider: Provider
): Promise<IdentityRow | null> {
  const row = await orm(db)
    .select()
    .from(identities)
    .where(and(eq(identities.email, email), eq(identities.provider, provider)))
    .get();
  return row ? toRow(row) : null;
}

/** One connected identity without its credential. What the speaker rule sees. */
export type ConnectedIdentity = Pick<
  IdentityRow,
  "email" | "externalId" | "connectedAt" | "updatedAt"
>;

/**
 * Every row for one provider, credential column deliberately NOT selected —
 * the speaker rule (src/identity/speaker.ts) chooses a person, and the token is
 * re-read at the last trusted moment by `getDecryptedToken`. Roster filtering
 * happens in the caller: this function does not know who is a fire-fighter.
 */
export async function listConnected(
  db: D1Database,
  provider: Provider
): Promise<ConnectedIdentity[]> {
  const results = await orm(db)
    .select({
      email: identities.email,
      external_id: identities.external_id,
      connected_at: identities.connected_at,
      updated_at: identities.updated_at,
    })
    .from(identities)
    .where(eq(identities.provider, provider))
    .all();
  return results.map((r) => ({
    email: r.email,
    externalId: r.external_id,
    connectedAt: r.connected_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * The dashboard's connect page: every roster member and what they have hooked
 * up. Built from the roster in code plus one `SELECT email, provider` — the
 * query deliberately selects no token column, so there is no ciphertext in this
 * function's reach to leak by accident.
 */
export async function listConnectStatus(
  db: D1Database
): Promise<ConnectStatus[]> {
  const results = await orm(db)
    .select({ email: identities.email, provider: identities.provider })
    .from(identities)
    .all();

  const connected = new Map<string, Set<Provider>>();
  for (const { email, provider } of results) {
    let providers = connected.get(email);
    if (!providers) {
      providers = new Set();
      connected.set(email, providers);
    }
    providers.add(provider);
  }

  const decorate = (
    email: string,
    role: ConnectStatus["role"]
  ): ConnectStatus => {
    const providers = connected.get(email);
    return {
      email,
      role,
      slack: providers?.has("slack") ?? false,
      github: providers?.has("github") ?? false,
    };
  };

  return [
    ...FIREFIGHTERS.map((email) => decorate(email, "firefighter")),
    ...VIEWERS.map((email) => decorate(email, "viewer")),
  ];
}
