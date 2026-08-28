import { describe, expect, it } from "vitest";

import {
  connectBadge,
  decisionBadge,
  effectStateBadge,
  originBadge,
  runStatusBadge,
  SHADOW_BADGE,
} from "@/lib/status";

describe("status → badge", () => {
  it("spends the attention tone only on states that need a human", () => {
    expect(runStatusBadge("awaiting_approval").tone).toBe("attention");
    expect(runStatusBadge("live").tone).toBe("attention");
    expect(runStatusBadge("live").pulse).toBe(true);
    expect(runStatusBadge("awaiting_approval").pulse).toBeFalsy();
    for (const s of ["idle", "done", "failed"] as const) {
      expect(runStatusBadge(s).tone).not.toBe("attention");
      expect(runStatusBadge(s).pulse).toBeFalsy();
    }
  });

  it("maps the rest", () => {
    expect(runStatusBadge("done").tone).toBe("success");
    expect(runStatusBadge("failed").tone).toBe("destructive");
    expect(runStatusBadge("idle").tone).toBe("neutral");
    expect(originBadge("slack").label).toBe("slack");
    expect(SHADOW_BADGE.tone).toBe("shadow");
    expect(connectBadge(true, "slack").tone).toBe("success");
    expect(connectBadge(false, "github").tone).toBe("neutral");
    expect(decisionBadge("rejected").tone).toBe("destructive");
    expect(decisionBadge("pending").tone).toBe("attention");
    expect(effectStateBadge("in_doubt").tone).toBe("warning");
  });

  it("gives every badge a meaning sentence for its tooltip", () => {
    expect(runStatusBadge("idle").meaning.length).toBeGreaterThan(10);
    expect(effectStateBadge("in_doubt").meaning).toMatch(/may or may not/);
  });
});
