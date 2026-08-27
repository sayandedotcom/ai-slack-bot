/**
 * Pure scorer: turns stored triage decisions into precision/recall. No I/O --
 * callers (Task 5) fetch rows from D1 and pass them in.
 *
 * Positive class is `wake` (what the model decided to do). Ground truth is
 * `humanEngaged` (a real human replied in-thread within 24h).
 *
 * precision and recall are `null`, never 0, when their denominator is zero --
 * "we never woke anyone" and "we woke people and were always wrong" are
 * different facts, and collapsing the former to 0.0 would report a rate that
 * was never actually measured.
 */

export type TriageOutcomeRow = {
  eventId: string;
  wake: boolean;
  humanEngaged: boolean;
  why: string;
  text: string;
  permalink: string | null;
};

export type TriageScore = {
  n: number;
  truePos: number;
  falsePos: number;
  falseNeg: number;
  trueNeg: number;
  precision: number | null;
  recall: number | null;
  disagreements: TriageOutcomeRow[];
};

export function scoreTriage(
  rows: TriageOutcomeRow[],
  maxDisagreements = 25
): TriageScore {
  let truePos = 0;
  let falsePos = 0;
  let falseNeg = 0;
  let trueNeg = 0;
  const falseNegRows: TriageOutcomeRow[] = [];
  const falsePosRows: TriageOutcomeRow[] = [];

  for (const row of rows) {
    if (row.wake && row.humanEngaged) {
      truePos += 1;
    } else if (row.wake && !row.humanEngaged) {
      falsePos += 1;
      falsePosRows.push(row);
    } else if (!row.wake && row.humanEngaged) {
      falseNeg += 1;
      falseNegRows.push(row);
    } else {
      trueNeg += 1;
    }
  }

  const precision =
    truePos + falsePos === 0 ? null : truePos / (truePos + falsePos);
  const recall =
    truePos + falseNeg === 0 ? null : truePos / (truePos + falseNeg);

  // False negatives (missed wakes) cost more than false positives (spurious
  // wakes), so they fill the cap first.
  const disagreements = [...falseNegRows, ...falsePosRows].slice(
    0,
    maxDisagreements
  );

  return {
    n: rows.length,
    truePos,
    falsePos,
    falseNeg,
    trueNeg,
    precision,
    recall,
    disagreements,
  };
}
