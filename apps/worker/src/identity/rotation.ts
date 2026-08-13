/**
 * Who is on the fire-fighting shift right now, as pure UTC arithmetic.
 *
 * Deliberately NOT derived from `FIREFIGHTERS` in src/access/roster.ts: that
 * list answers "may this email decide an approval" and carries a temporary
 * personal override (sayandeten@gmail.com) for dashboard access. Paging is a
 * different question -- the override is not a fire-fighter and must never be
 * put on duty -- so the rotation gets its own list. Keep them separate even
 * though four of the entries happen to match today.
 *
 * A pure function of `nowMs` rather than stored state: shifts tile the
 * timeline forever, so there is nothing to persist and nothing to drift.
 */

/** The four fire-fighters, in shift order. */
// UNCONFIRMED: order pending Ronit (question sent 2026-08-13).
export const ROTATION: readonly string[] = [
  "ronit@zellify.app",
  "luka@zellify.app",
  "mikheil@zellify.app",
  "zurab@zellify.app",
];

/** Start of ROTATION[0]'s first shift. */
// UNCONFIRMED: epoch pending Ronit (question sent 2026-08-13). An epoch off by
// a day silently nudges the wrong person -- see phase-12 notes.
export const ROTATION_EPOCH_MS = Date.parse("2026-08-10T00:00:00Z");

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
