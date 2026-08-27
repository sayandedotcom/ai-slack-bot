"use client";

import type { ReactNode } from "react";

import { useRunAgent } from "@/lib/hooks/use-run-agent";
import { RunView } from "./run-view";

/**
 * The wired run view. Everything it knows comes from the socket.
 *
 * Four lines, and that is the point of the split: `RunView` is pure and holds
 * every state this can be in, so the socket lives in exactly one file and is
 * never in the way of rendering the thing.
 *
 * Loaded through `next/dynamic({ ssr: false })` by `run-panel.tsx`.
 * `usePartySocket` constructs its socket inside `useState`, which runs during
 * the server render too; `startClosed` keeps it from dialling, but there is
 * nothing for a server render to produce here and the client-only boundary
 * makes that explicit rather than incidental.
 */
export function RunSession({
  runId,
  approvals,
}: {
  runId: string;
  approvals?: ReactNode;
}) {
  const run = useRunAgent(runId);

  return (
    <RunView
      connection={run.connection}
      connectionError={run.connectionError}
      messages={run.messages}
      busy={run.busy}
      turnError={run.turnError}
      sendError={run.sendError}
      onSend={run.send}
      onDismissError={run.dismissError}
      approvals={approvals}
    />
  );
}

export default RunSession;
