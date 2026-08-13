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
  it("is the four @zellify.app fire-fighters, in order", () => {
    expect(ROTATION).toEqual([
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
    expect(ROTATION_EPOCH_MS).toBe(Date.parse("2026-08-10T00:00:00Z"));
  });

  it("excludes the personal override that FIREFIGHTERS carries", () => {
    expect(FIREFIGHTERS).toContain(OVERRIDE_EMAIL);
    expect(ROTATION).not.toContain(OVERRIDE_EMAIL);
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

  it("wraps 3 -> 0 after a full cycle", () => {
    expect(onDuty(ROTATION_EPOCH_MS + 3 * SHIFT_MS).index).toBe(3);
    const wrapped = onDuty(ROTATION_EPOCH_MS + 4 * SHIFT_MS);
    expect(wrapped.index).toBe(0);
    expect(wrapped.email).toBe(ROTATION[0]);
  });

  it("names index 0 as next while index 3 is on duty", () => {
    const shift = onDuty(ROTATION_EPOCH_MS + 3 * SHIFT_MS);
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

  it("never puts the personal override on duty across 30 sampled days", () => {
    for (let day = 0; day < 30; day += 1) {
      const shift = onDuty(ROTATION_EPOCH_MS + day * 86_400_000);
      expect(shift.email).not.toBe(OVERRIDE_EMAIL);
      expect(shift.nextEmail).not.toBe(OVERRIDE_EMAIL);
    }
  });
});
