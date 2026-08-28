"use client";

import { Skeleton } from "@workspace/ui/components/skeleton";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { isDemo } from "@/lib/api/client";
import { chipsByTurn } from "@/lib/api/effects";
import { demoEffectsFor } from "@/lib/fixtures/effects";
import { demoTranscriptFor } from "@/lib/fixtures/run-transcript";
import { RunView } from "./run-view";

/**
 * Which run view to render: the live socket, or the fixture.
 *
 * The branch is at the COMPONENT level rather than inside the hook, because a
 * hook cannot be called conditionally and `useRunAgent` would otherwise open a
 * socket in demo mode — to a host that, in demo mode, deliberately does not
 * exist.
 *
 * The two branches share `RunView`, so a demo is a demo of the real component
 * and not of a lookalike.
 */

const RunSession = dynamic(() => import("./run-session"), {
  ssr: false,
  loading: () => <Skeleton className="min-h-0 flex-1 rounded-lg" />,
});

export function RunPanel({
  runId,
  approvals,
}: {
  runId: string;
  approvals?: ReactNode;
}) {
  if (isDemo()) {
    return (
      <RunView
        connection="live"
        connectionError={false}
        messages={demoTranscriptFor(runId)}
        busy={false}
        turnError={false}
        sendError={null}
        onSend={() => {}}
        onDismissError={() => {}}
        approvals={approvals}
        steerDisabledReason="Steering is off in demo mode — there is no run behind this transcript."
        chips={chipsByTurn(demoEffectsFor(runId))}
        canCancel={false}
        onCancel={() => {}}
        cancelling={false}
      />
    );
  }

  return <RunSession runId={runId} approvals={approvals} />;
}
