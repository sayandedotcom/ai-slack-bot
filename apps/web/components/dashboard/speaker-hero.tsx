"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert";
import { TriangleAlert } from "lucide-react";

import type { Roster } from "@/lib/api/roster";
import type { PanelState } from "@/lib/panel-state";

/**
 * Nobody can speak.
 *
 * This is an error state, not an attention state — every customer-facing
 * write refuses until it clears — so it renders `destructive`, the one
 * chromatic tone this app reserves for something actually broken. `attention`
 * is spent elsewhere, on the "speaks by default" marker in the team table,
 * which is a fact about who is chosen, not an alarm.
 *
 * Returns null whenever a speaker exists, so a page can render this
 * unconditionally above the table and it only ever appears when it has
 * something to say.
 */
export function RefusalBanner({ state }: { state: PanelState<Roster> }) {
  if (state.kind !== "ready" || state.data.speaker !== null) return null;

  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Nobody can speak</AlertTitle>
      <AlertDescription>
        No fire-fighter has connected Slack, so every customer-facing reply is
        refused. Connect an account in the team table below to unblock it.
      </AlertDescription>
    </Alert>
  );
}
