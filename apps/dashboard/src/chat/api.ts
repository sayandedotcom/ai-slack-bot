/**
 * The chat page's network surface: two thin calls over the runs API. Creation
 * is `POST /api/runs` — the same endpoint triage does NOT use; a body with
 * `firstMessage` mints a run with origin "chat" (`createChatRun`). Listing is
 * the shared runs list filtered here, client-side: the worker has no `origin`
 * query param and chat volume does not justify one.
 */

import { fetchRuns, postJson } from "../runs/api";
import type { RunDetail, RunSummary } from "../runs/api";

/**
 * Every call always creates a new run — `createChatRun` in the worker mints a
 * fresh run key unconditionally. `requestId` only stabilizes the id of the
 * *first turn* inside whichever run gets created (`steer:{requestId}`); it
 * gives no run-level idempotency. If a response is lost in flight and the
 * caller submits again, a second run WILL be created. Real dedupe on
 * `requestId` at the run level needs a worker-side change — out of scope for
 * this phase.
 */
export async function createChat(firstMessage: string, requestId: string): Promise<RunDetail> {
  const body = await postJson<{ run: RunDetail }>("/api/runs", { firstMessage, requestId });
  return body.run;
}

/**
 * The Think-chassis half of the same door: mint the run and NOTHING else.
 *
 * `POST /api/runs` with a `firstMessage` appends that turn through the legacy
 * coordinator, which is the wrong session on this chassis — the turn would land
 * in `RunDO` while the browser watches `RunAgent`, and the first thing the
 * human typed would silently never be answered. So the chat page creates an
 * empty run here and sends the opening message through the agent socket, which
 * is the only writer to the session tree the transcript is drawn from.
 *
 * No `requestId`: it only ever stabilized the id of the first turn, and there
 * is no first turn on this path.
 */
export async function createEmptyChat(): Promise<RunDetail> {
  const body = await postJson<{ run: RunDetail }>("/api/runs", {});
  return body.run;
}

export async function fetchChatSessions(): Promise<RunSummary[]> {
  // 200 is RUN_LIST_MAX_LIMIT on the worker — the widest window the list
  // endpoint accepts. The endpoint has no `origin` filter, so this over-fetches
  // and filters client-side below; with enough recent Slack-triage volume a
  // smaller limit can starve chat runs out of the page entirely. The real fix
  // is an `origin` query param on the worker, deferred.
  const runs = await fetchRuns(200);
  return runs
    .filter((run) => run.origin === "chat")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
