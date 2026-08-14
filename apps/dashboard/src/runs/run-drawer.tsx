import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@workspace/ui/components/button";

import { CopyId } from "../components/copy-id";
import { fetchRunUsageTotal, type RunSummary } from "./api";
import { OriginBadge, ShadowBadge, StatusChip } from "./run-list";

/**
 * The chrome around one run: a right-side overlay that slides in over the
 * dashboard rather than navigating to it. That is a deliberate product choice —
 * an operator opening a run is glancing, not leaving, and the list behind must
 * keep polling so the drawer never becomes a dead end you have to back out of.
 *
 * It owns identity, cost and dismissal only. The transcript arrives as
 * `children`, which is what keeps this file free of any socket or session
 * dependency: the caller decides what a run's body is.
 */

/**
 * The usage total is a decimal string from the ledger. It is stored and printed
 * as a string end to end — parsing it into a JS number would round money for
 * cosmetic reasons.
 */
type Usage = { kind: "loading" } | { kind: "ready"; total: string } | { kind: "hidden" };

export function RunDrawer({
  runId,
  run,
  onClose,
  children,
}: {
  runId: string;
  run?: RunSummary;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const [usage, setUsage] = useState<Usage>({ kind: "loading" });
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Whatever had focus when the drawer opened — usually the list row — so
  // closing puts the keyboard back where it was instead of at the document top.
  const returnRef = useRef<Element | null>(null);

  // Fetched once per opened run, never polled: a cost total that ticks while
  // you read it is a distraction, and the drawer is short-lived anyway.
  useEffect(() => {
    let alive = true;
    setUsage({ kind: "loading" });
    fetchRunUsageTotal(runId).then(
      (total) => {
        if (alive) setUsage({ kind: "ready", total });
      },
      () => {
        // A missing cost line is not worth an error banner over a live incident.
        if (alive) setUsage({ kind: "hidden" });
      },
    );
    return () => {
      alive = false;
    };
  }, [runId]);

  // Escape closes from anywhere, including from inside the transcript. Bound on
  // the document rather than the panel so it works before focus lands.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    returnRef.current = document.activeElement;
    panelRef.current?.focus();
    return () => {
      const target = returnRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
    // Mount only: re-focusing the panel on every runId change would steal focus
    // out of the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop is a plain div with a click handler and no role: Escape and
          the × button are the accessible affordances, so exposing this as a
          second button would only add noise to the tab order. */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Run detail"
        tabIndex={-1}
        // `animate-in` runs once on mount; the drawer is unmounted on close, so
        // there is nothing left behind to trap focus or swallow clicks.
        className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l bg-background shadow-xl outline-none duration-200 animate-in slide-in-from-right"
      >
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {run === undefined ? null : (
                <>
                  <OriginBadge origin={run.origin} />
                  <StatusChip status={run.status} />
                  {run.shadow ? (
                    <ShadowBadge label="shadow — nothing this run does reaches a customer" />
                  ) : null}
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <CopyId runId={runId} />
              {usage.kind === "loading" ? (
                <span className="tabular-nums">cost —</span>
              ) : usage.kind === "ready" ? (
                <span className="tabular-nums">cost ${usage.total}</span>
              ) : null}
            </div>
          </div>

          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close run detail">
            ×
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
