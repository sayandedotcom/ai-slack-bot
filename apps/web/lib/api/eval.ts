import { demoTriage } from "../fixtures/eval";
import { fixture, getJson, isDemo } from "./client";

export type TriageDays = 7 | 30 | 90;

export type TriageScore = {
  n: number;
  truePos: number;
  falsePos: number;
  falseNeg: number;
  trueNeg: number;
  /** null when the denominator is zero — "not measured", never 0.0. */
  precision: number | null;
  recall: number | null;
};

export type TriageReport = {
  score: TriageScore;
  windowDays: number;
  unripeExcluded: number;
  truncated: boolean;
};

export function getTriageScore(days: TriageDays): Promise<TriageReport> {
  if (isDemo()) return fixture({ ...demoTriage, windowDays: days });
  return getJson<TriageReport>(`/api/eval/triage?days=${days}`);
}
