/**
 * Who may see or decide an approval, hardcoded.
 *
 * Confirmed 2026-08-13 by the operator relaying their manager: "a hardcoded
 * map of seven emails to roles is fine; nobody is judging IAM here." Two
 * roles, three-day fire-fighter rotation vs. read-only viewers. Full
 * provenance is in docs/superpowers/plans/phase-11-notes.md ("Roster —
 * confirmed"); the shape this file must expose is the plan's "Authorization
 * seam".
 *
 * Phase 12 extends this file with OAuth, token rotation and real identity
 * management. Phase 11 only consumes it, so the table stays this narrow on
 * purpose -- do not grow it into a general permissions system here.
 */

/**
 * Fire-fighters: rotate on 3-day shifts, connect Slack and GitHub, act on
 * threads, and are the only role that may decide a `PATCH /api/approvals/:id`
 * (see the shared contracts' HTTP API table).
 */
export const FIREFIGHTERS: readonly string[] = [
  "ronit@zellify.app",
  "luka@zellify.app",
  "mikheil@zellify.app",
  "zurab@zellify.app",
  // TEMPORARY personal override -- the developer building this phase, who has
  // no @zellify.app address. Placed in FIREFIGHTERS rather than VIEWERS
  // because the Task 10 live proof requires this account to PATCH an
  // approval, and PATCH is fire-fighters-only. Remove this line -- and the
  // matching entry in the Cloudflare Access "firefighter - Dashboard"
  // application's policy -- once the developer has a @zellify.app address or
  // the engagement ends. Tracked as release gate G2 in
  // docs/superpowers/plans/phase-11-notes.md and in README.md.
  // G2-TEMP-OVERRIDE -- grep this exact string to find every tag of this gate.
  "sayandeten@gmail.com",
];

/** Viewers: dashboard and chat only, no rotation, no OAuth, read-only. */
export const VIEWERS: readonly string[] = [
  "marcus@zellify.app",
  "nils@zellify.app",
  "eric@zellify.app",
];

/** True for the four fire-fighters plus the documented personal override. */
export function isFirefighter(email: string): boolean {
  return FIREFIGHTERS.includes(email);
}

/** True for any of the seven roster emails plus the documented override. */
export function isTeamMember(email: string): boolean {
  return isFirefighter(email) || VIEWERS.includes(email);
}
