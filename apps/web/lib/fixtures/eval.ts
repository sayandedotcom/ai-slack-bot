import type { TriageReport } from "../api/eval";

export const demoTriage: TriageReport = {
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
};
