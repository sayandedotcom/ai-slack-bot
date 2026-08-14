/**
 * The chat page's network surface: two thin calls over the runs API. Creation
 * is `POST /api/runs` — the same endpoint triage does NOT use; a body with
 * `firstMessage` mints a run with origin "chat" (`createChatRun`), idempotent
 * on `requestId`. Listing is the shared runs list filtered here, client-side:
 * the worker has no `origin` query param and chat volume does not justify one.
 */

import { fetchRuns, postJson } from "../runs/api";
import type { RunDetail, RunSummary } from "../runs/api";

export async function createChat(firstMessage: string, requestId: string): Promise<RunDetail> {
  const body = await postJson<{ run: RunDetail }>("/api/runs", { firstMessage, requestId });
  return body.run;
}

export async function fetchChatSessions(): Promise<RunSummary[]> {
  const runs = await fetchRuns(50);
  return runs
    .filter((run) => run.origin === "chat")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
