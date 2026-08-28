import type { TriageReport } from "@/lib/api/eval";

function pct(v: number | null): string {
  return v === null ? "not measured" : `${(v * 100).toFixed(1)}%`;
}

/**
 * The triage score for one window: precision, recall, and the raw counts
 * behind them.
 *
 * `precision`/`recall` are `number | null` — `null` means the denominator was
 * zero, i.e. the rate was not measured, and it renders as the words "not
 * measured" rather than as `0.0%` or `NaN`. Reporting a bad rate and
 * reporting no rate are different facts; collapsing them would lie in the
 * direction of "this looks fine."
 */
export function TriageScoreView({ report }: { report: TriageReport }) {
  const s = report.score;
  const cells: [string, string, string][] = [
    [
      "precision",
      pct(s.precision),
      "Of the wakes, how many a human agreed with.",
    ],
    [
      "recall",
      pct(s.recall),
      "Of the threads a human answered, how many triage woke on.",
    ],
    [
      "decisions",
      String(s.n),
      `Ripe decisions in ${report.windowDays} days; ${report.unripeExcluded} too recent to score.`,
    ],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {cells.map(([label, value, meaning]) => (
          <div key={label} className="rounded-lg border p-4">
            <p className="eyebrow">{label}</p>
            <p className="machine mt-1 font-medium text-2xl">{value}</p>
            <p className="mt-1 text-muted-foreground text-xs">{meaning}</p>
          </div>
        ))}
      </div>
      <dl className="machine grid grid-cols-4 gap-2 text-muted-foreground text-xs">
        <div>
          <dt>true pos</dt>
          <dd>{s.truePos}</dd>
        </div>
        <div>
          <dt>false pos</dt>
          <dd>{s.falsePos}</dd>
        </div>
        <div>
          <dt>false neg</dt>
          <dd>{s.falseNeg}</dd>
        </div>
        <div>
          <dt>true neg</dt>
          <dd>{s.trueNeg}</dd>
        </div>
      </dl>
      {report.truncated ? (
        <p className="text-muted-foreground text-xs">
          Capped at 5,000 rows; the window is larger than what was scored.
        </p>
      ) : null}
    </div>
  );
}
