/**
 * Who is on the fire-fighting shift right now, as pure UTC arithmetic.
 *
 * Deliberately NOT derived from `FIREFIGHTERS` in src/access/roster.ts: that
 * list answers "may this email decide an approval", which is a different
 * question from "who gets paged and whose Slack token sends the reply". Keep
 * them separate even though the entries overlap today.
 *
 * TRIAL TESTING OVERRIDE, 2026-08-14 (release gate G12-5): the developer's
 * personal address sits at index 0. This file previously asserted the opposite
 * -- that the override must never be put on duty -- and that was right while
 * the override existed only for dashboard access. It stopped being right when
 * Phase 13 landed: the on-duty engineer's own Slack token is what sends a
 * customer reply, none of the four @zellify.app engineers has connected an
 * account, and a proof that nobody can run is not a proof. So the exclusion is
 * being changed deliberately and visibly rather than quietly broken.
 *
 * REMOVE BEFORE HANDOVER: delete the index-0 entry, restore
 * ROTATION_EPOCH_MS to the real boundary Ronit supplies, and re-tighten the
 * test in test/rotation.test.ts that now documents this inclusion.
 *
 * A pure function of `nowMs` rather than stored state: shifts tile the
 * timeline forever, so there is nothing to persist and nothing to drift.
 */

/** The rotation, in shift order. */
// UNCONFIRMED: the four @zellify.app names and their order are pending Ronit
// (question sent 2026-08-13). Index 0 is the trial testing override above.
export const ROTATION: readonly string[] = [
  "sayandeten@gmail.com", // TEMPORARY -- release gate G12-5, remove before handover
  "ronit@zellify.app",
  "luka@zellify.app",
  "mikheil@zellify.app",
  "zurab@zellify.app",
];

/**
 * Start of ROTATION[0]'s first shift.
 *
 * Set to 2026-08-14T00:00:00Z so the trial tester at index 0 is on duty for the
 * live Phase 13 proof rather than an engineer who cannot receive it. This is
 * CONFIGURATION, not a change to the rotation math: `onDuty` is unchanged and
 * still tiles the timeline forever. Restoring the real schedule is this one
 * line plus deleting index 0.
 */
// UNCONFIRMED: the real boundary is pending Ronit. An epoch off by a day
// silently nudges the wrong person -- see phase-12 notes.
export const ROTATION_EPOCH_MS = Date.parse("2026-08-14T00:00:00Z");

/** Three-day shifts, per the roster's stated cadence. */
export const SHIFT_MS = 3 * 86_400_000;

/** The shift covering some instant: who, which slot, and its half-open bounds. */
export type Shift = {
  email: string;
  index: number;
  /** Inclusive start of the shift containing `nowMs`. */
  shiftStartMs: number;
  /** Exclusive end -- the next fire-fighter's `shiftStartMs`. */
  shiftEndMs: number;
  nextEmail: string;
};

/**
 * The shift containing `nowMs`. Defined for every instant, including before
 * the epoch: the modulo is floored so a negative shift count still lands on a
 * real rotation member instead of a negative index.
 */
export function onDuty(nowMs: number): Shift {
  const shiftsSince = Math.floor((nowMs - ROTATION_EPOCH_MS) / SHIFT_MS);
  const index =
    ((shiftsSince % ROTATION.length) + ROTATION.length) % ROTATION.length;
  const shiftStartMs = ROTATION_EPOCH_MS + shiftsSince * SHIFT_MS;
  return {
    email: ROTATION[index]!,
    index,
    shiftStartMs,
    shiftEndMs: shiftStartMs + SHIFT_MS,
    nextEmail: ROTATION[(index + 1) % ROTATION.length]!,
  };
}
