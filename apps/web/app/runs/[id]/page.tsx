"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@workspace/ui/components/button";
import { ArrowLeft, FlaskConical, PanelRight } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState } from "react";

import { ErrorBoundary } from "@/components/common/error-boundary";
import { RunApprovals } from "@/components/run/run-approvals";
import { RunPanel } from "@/components/run/run-panel";
import { RunInspector } from "@/components/runs/run-inspector";
import { isDemo } from "@/lib/api/client";
import { getRun } from "@/lib/api/runs";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";
import { useNow } from "@/lib/hooks/use-now";
import { POLL_MS, queryKeys } from "@/lib/query/keys";

/** Where the inspector's open state lives across a reload. */
const INSPECTOR_STORAGE_KEY = "runs.inspector";

/**
 * One run, live — the detail half of the `/runs` split view.
 *
 * Everything in the header comes from D1 through `GET /api/runs/:id`
 * (rendering a run must not wake it); the transcript below comes from the
 * Durable Object over its own socket. The two are separate on purpose: the
 * header still renders when the socket cannot connect.
 */
export default function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { identity } = useIdentityQuery();
  const now = useNow();

  const run = useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => getRun(id),
    // The status moves as the agent works, and the header is the one place
    // the reader looks to know whether it is still going.
    refetchInterval: POLL_MS.runs,
  });

  // Read from storage only after mount — reading during render would disagree
  // with the server pass and fail hydration — and only ever inside try/catch:
  // private browsing and a blocked site-data setting both throw on access.
  const [inspector, setInspector] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(INSPECTOR_STORAGE_KEY);
      if (stored !== null) setInspector(stored === "true");
    } catch {
      // No storage to read from — the default stands.
    }
  }, []);

  const toggleInspector = () => {
    setInspector((value) => {
      const next = !value;
      try {
        localStorage.setItem(INSPECTOR_STORAGE_KEY, String(next));
      } catch {
        // Nothing to persist to; the toggle still works for this render.
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2">
          <Link
            href="/runs"
            className="flex items-center gap-1.5 text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline lg:hidden"
          >
            <ArrowLeft className="size-3" aria-hidden="true" />
            Runs
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-medium text-sm">
            {run.data?.summary ?? (
              <span className="text-muted-foreground italic">
                No summary yet
              </span>
            )}
          </h1>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleInspector}
            aria-pressed={inspector}
            aria-label="Toggle details"
          >
            <PanelRight />
          </Button>
        </header>

        {isDemo() ? <DemoNotice /> : null}

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <ErrorBoundary
            message="This transcript could not be rendered."
            resetKey={id}
          >
            <RunPanel
              runId={id}
              approvals={
                <RunApprovals runId={id} role={identity?.role ?? "viewer"} />
              }
            />
          </ErrorBoundary>
        </div>
      </div>

      {inspector && run.data ? (
        <aside className="hidden w-72 shrink-0 border-l xl:block">
          <RunInspector run={run.data} now={now} />
        </aside>
      ) : null}
    </div>
  );
}

function DemoNotice() {
  return (
    <div className="flex items-start gap-2.5 border-b border-dashed px-4 py-2 text-muted-foreground text-sm">
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-pretty">
        A fixture transcript, in the shape the socket broadcasts. A live build
        opens a WebSocket to{" "}
        <code className="machine text-xs">/api/runs/:id/agent</code> and
        steering works from here.
      </span>
    </div>
  );
}
