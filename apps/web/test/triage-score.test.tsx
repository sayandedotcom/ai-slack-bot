import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TriageScoreView } from "@/components/eval/triage-score";

describe("TriageScoreView", () => {
  it("renders percentages and never NaN", () => {
    const { container } = render(
      <TriageScoreView
        report={{
          score: {
            n: 212,
            truePos: 15,
            falsePos: 4,
            falseNeg: 2,
            trueNeg: 191,
            precision: 15 / 19,
            recall: 15 / 17,
          },
          windowDays: 30,
          unripeExcluded: 6,
          truncated: false,
        }}
      />
    );
    expect(screen.getByText("78.9%")).toBeInTheDocument();
    expect(screen.getByText("88.2%")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NaN");
  });
  it("says not measured for a null rate", () => {
    render(
      <TriageScoreView
        report={{
          score: {
            n: 0,
            truePos: 0,
            falsePos: 0,
            falseNeg: 0,
            trueNeg: 0,
            precision: null,
            recall: null,
          },
          windowDays: 7,
          unripeExcluded: 0,
          truncated: false,
        }}
      />
    );
    expect(screen.getAllByText("not measured")).toHaveLength(2);
  });
});
