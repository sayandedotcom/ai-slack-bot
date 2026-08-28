"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { chipsByTurn } from "@/lib/api/effects";
import { useRunEffects } from "@/lib/hooks/use-dashboard-data";
import { useRunAgent } from "@/lib/hooks/use-run-agent";
import { RunView } from "./run-view";

/**
 * The wired run view. Everything it knows comes from the socket, plus the
 * effect ledger for the chip strip — a separate D1 read, never invented from
 * the transcript.
 *
 * `RunView` is pure and holds every state this can be in, so the socket lives
 * in exactly one file and is never in the way of rendering the thing.
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
  const effects = useRunEffects(runId);
  const [cancelling, setCancelling] = useState(false);

  const onCancel = () => {
    setCancelling(true);
    void run
      .cancel()
      .then(() => toast("Cancel sent"))
      .catch(() => toast.error("Could not cancel"))
      .finally(() => setCancelling(false));
  };

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
      chips={chipsByTurn(effects.kind === "ready" ? effects.data : [])}
      canCancel={run.status === "live"}
      onCancel={onCancel}
      cancelling={cancelling}
    />
  );
}

export default RunSession;
