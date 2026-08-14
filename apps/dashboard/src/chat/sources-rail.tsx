import type { ReactNode } from "react";

import type { SourceChip } from "./citations";

/**
 * The answer's receipts: each cited fact links to the actual Slack message via
 * the worker-stored permalink. Renders nothing when there are no sources —
 * the rail earns its space only when the agent cited something.
 */
export function SourcesRail({ sources }: { sources: SourceChip[] }): ReactNode {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Sources" className="space-y-2">
      <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">Sources</h3>
      {/* Bounded height + own scroll so a long citation list can never squeeze
          the transcript above it down to nothing. */}
      <ul className="max-h-64 space-y-2 overflow-y-auto">
        {sources.map((source) => (
          <li key={source.permalink}>
            <a
              href={source.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-l-2 border-l-primary/60 bg-card px-3 py-2 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <p className="line-clamp-2 text-sm">{source.fact}</p>
              <p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                {source.channelId === null ? null : <span>#{source.channelId}</span>}
                <span className="tabular-nums">{source.ts}</span>
                <span className="ml-auto">open thread →</span>
              </p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
