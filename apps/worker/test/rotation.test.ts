/**
 * The rotation decides who gets woken up at 3am, so the boundary arithmetic
 * gets pinned here rather than trusted. In particular: shifts must tile the
 * timeline with no gap or overlap, the wrap must be exact, negative times
 * (a clock skew, a backfilled incident) must not produce an out-of-range
 * index, and the personal-override email from FIREFIGHTERS must never be
 * paged -- it is a dashboard account, not a fire-fighter.
 */
import { describe, it, expect } from "vitest";

import { FIREFIGHTERS } from "../src/access/roster";
import {
  ROTATION,
  ROTATION_EPOCH_MS,
  SHIFT_MS,
  onDuty,
} from "../src/identity/rotation";

const OVERRIDE_EMAIL = "sayandeten@gmail.com";

describe("rotation constants", () => {
  it("is the four @zellify.app fire-fighters, in order, behind the trial tester", () => {
    expect(ROTATION).toEqual([
      OVERRIDE_EMAIL, // TEMPORARY -- release gate G12-5
      "ronit@zellify.app",
      "luka@zellify.app",
      "mikheil@zellify.app",
      "zurab@zellify.app",
    ]);
  });

  it("uses a three-day shift", () => {
    expect(SHIFT_MS).toBe(3 * 86_400_000);
  });

  it("starts at the UTC epoch date", () => {
    expect(ROTATION_EPOCH_MS).toBe(Date.parse("2026-08-14T00:00:00Z"));
  });

  /**
   * This test used to assert the OPPOSITE -- that the personal override is
   * never on duty. It was inverted deliberately on 2026-08-14 (release gate
   * G12-5), because Phase 13 made the on-duty engineer's Slack token the thing
   * that sends a customer reply, and no @zellify.app engineer has connected
   * one. It stays a TEST rather than a deleted assertion so that removing the
   * override at handover is a red suite, not something anyone has to remember.
   */
  it("TEMPORARY: carries the trial tester at index 0 (release gate G12-5)", () => {
    expect(FIREFIGHTERS).toContain(OVERRIDE_EMAIL);
    expect(ROTATION[0]).toBe(OVERRIDE_EMAIL);
    // The four real fire-fighters must still all be present and in order --
    // the override is an addition for the trial, never a replacement.
    expect(ROTATION.slice(1)).toEqual([
      "ronit@zellify.app",
      "luka@zellify.app",
      "mikheil@zellify.app",
      "zurab@zellify.app",
    ]);
  });
});

describe("onDuty", () => {
  it("puts index 0 on duty at exactly the epoch", () => {
    const shift = onDuty(ROTATION_EPOCH_MS);
    expect(shift.index).toBe(0);
    expect(shift.email).toBe(ROTATION[0]);
    expect(shift.shiftStartMs).toBe(ROTATION_EPOCH_MS);
    expect(shift.shiftEndMs).toBe(ROTATION_EPOCH_MS + SHIFT_MS);
  });

  it("keeps index 0 through the last millisecond of the first shift", () => {
    expect(onDuty(ROTATION_EPOCH_MS + SHIFT_MS - 1).index).toBe(0);
  });

  it("hands over to index 1 exactly at the shift boundary", () => {
    const shift = onDuty(ROTATION_EPOCH_MS + SHIFT_MS);
    expect(shift.index).toBe(1);
    expect(shift.email).toBe(ROTATION[1]);
    expect(shift.shiftStartMs).toBe(ROTATION_EPOCH_MS + SHIFT_MS);
  });

  // Written against ROTATION.length rather than a literal 4 on purpose: the
  // trial adds a fifth entry (G12-5) and handover removes it again, and the
  // property under test -- the cycle wraps at the end -- is true either way.
  it("wraps back to index 0 after a full cycle", () => {
    const last = ROTATION.length - 1;
    expect(onDuty(ROTATION_EPOCH_MS + last * SHIFT_MS).index).toBe(last);
    const wrapped = onDuty(ROTATION_EPOCH_MS + ROTATION.length * SHIFT_MS);
    expect(wrapped.index).toBe(0);
    expect(wrapped.email).toBe(ROTATION[0]);
  });

  it("names index 0 as next while the last member is on duty", () => {
    const shift = onDuty(ROTATION_EPOCH_MS + (ROTATION.length - 1) * SHIFT_MS);
    expect(shift.nextEmail).toBe(ROTATION[0]);
  });

  it("names the following member as next mid-cycle", () => {
    expect(onDuty(ROTATION_EPOCH_MS + SHIFT_MS).nextEmail).toBe(ROTATION[2]);
  });

  it("returns a real rotation member before the epoch", () => {
    for (const back of [1, SHIFT_MS, 5 * SHIFT_MS, 9 * SHIFT_MS + 17]) {
      const shift = onDuty(ROTATION_EPOCH_MS - back);
      expect(shift.index).toBeGreaterThanOrEqual(0);
      expect(shift.index).toBeLessThan(ROTATION.length);
      expect(ROTATION).toContain(shift.email);
      expect(shift.email).toBe(ROTATION[shift.index]);
    }
  });

  it("covers the instant it reports, with a shift exactly SHIFT_MS long", () => {
    for (let day = -30; day < 30; day += 1) {
      const now = ROTATION_EPOCH_MS + day * 86_400_000 + 12 * 3_600_000;
      const shift = onDuty(now);
      expect(shift.shiftEndMs - shift.shiftStartMs).toBe(SHIFT_MS);
      expect(shift.shiftStartMs).toBeLessThanOrEqual(now);
      expect(shift.shiftEndMs).toBeGreaterThan(now);
    }
  });

  /**
   * Also inverted on 2026-08-14 (release gate G12-5). The bound it enforces
   * now is the one that still matters while the override is in the rotation:
   * the trial tester takes ONE slot like anyone else and does not displace a
   * real fire-fighter. Deleting the index-0 entry at handover turns this red,
   * which is the point.
   */
  it("TEMPORARY: gives the trial tester exactly one slot per cycle (G12-5)", () => {
    expect(onDuty(ROTATION_EPOCH_MS).email).toBe(OVERRIDE_EMAIL);
    for (let slot = 1; slot < ROTATION.length; slot += 1) {
      expect(onDuty(ROTATION_EPOCH_MS + slot * SHIFT_MS).email).not.toBe(OVERRIDE_EMAIL);
    }
    // Every real fire-fighter still gets their turn within one cycle.
    const cycle = Array.from({ length: ROTATION.length }, (_, slot) =>
      onDuty(ROTATION_EPOCH_MS + slot * SHIFT_MS).email,
    );
    expect(new Set(cycle)).toEqual(new Set(ROTATION));
  });
});
