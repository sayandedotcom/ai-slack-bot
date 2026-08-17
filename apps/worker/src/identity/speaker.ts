/**
 * Whose name goes on what this system does in public.
 *
 * There is NO SHIFT and NO CLOCK here (removed 2026-08-17). The three-day
 * rotation this file replaces handed the on-duty seat to an engineer with no
 * connected identity at 00:00 UTC, and for the next three days every
 * customer-facing write refused `identity_unavailable`, every approval came
 * out `blocked: not connected` and the nudge fell back to the channel — with
 * a connected fire-fighter sitting right there. Time is not a fact about who
 * can speak; a connected credential is.
 *
 * The rule, in full:
 *
 *  1. The pool is the fire-fighter roster (`FIREFIGHTERS`), in roster order.
 *     Same list that decides who may PATCH an approval — being able to sign
 *     off on a message and being able to have your name on it are one status
 *     now, which is what "everyone on the roster is a fire-fighter" means.
 *  2. Only a pool member who has connected the provider in question is
 *     eligible. Nobody connected → `null`, and every caller keeps its
 *     fail-closed refusal exactly as before.
 *  3. A `preferredEmail` — the human who decided an approval — wins if they
 *     are an eligible pool member. Otherwise the first eligible member in
 *     roster order. Roster order rather than "most recently connected" so a
 *     re-consent cannot silently swap whose messages the prompt samples.
 *
 * `preferredEmail` is validated against the roster, never trusted: an
 * `identities` row for someone off the roster (a viewer, an ex-member) cannot
 * make that person the speaker even if the caller names them.
 *
 * Deliberately a person, not a token. The credential is re-read at the last
 * trusted moment (`getDecryptedToken`) by the one port allowed to hold it.
 */
import { FIREFIGHTERS, isFirefighter } from "../access/roster";
import { listConnected, type ConnectedIdentity, type Provider } from "../db/identities";

/** The eligible pool, in the order ties break. */
export const SPEAKER_POOL: readonly string[] = FIREFIGHTERS;

export type Speaker = ConnectedIdentity;

/**
 * The pure half of the rule, over rows already read. Exported so a caller
 * that needs the choice AS OF an earlier instant (the engineer-voice sampler
 * freezes it per UTC day for prompt-cache stability) can filter the rows
 * first and still get exactly this tie-break.
 */
export function pickSpeaker(
  rows: readonly ConnectedIdentity[],
  preferredEmail?: string | null,
): Speaker | null {
  const byEmail = new Map(rows.map((r) => [r.email, r] as const));

  if (preferredEmail && isFirefighter(preferredEmail)) {
    const preferred = byEmail.get(preferredEmail);
    if (preferred) return preferred;
  }
  for (const email of SPEAKER_POOL) {
    const row = byEmail.get(email);
    if (row) return row;
  }
  return null;
}

export async function resolveSpeaker(
  db: D1Database,
  provider: Provider,
  preferredEmail?: string | null,
): Promise<Speaker | null> {
  return pickSpeaker(await listConnected(db, provider), preferredEmail);
}
