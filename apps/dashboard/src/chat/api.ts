/**
 * Starting a run from the dashboard.
 *
 * One POST, and the client id it carries is the whole idempotency story: the
 * worker derives the run's key from it (so a retry resolves to the SAME run
 * rather than leaving a half-empty one behind) and uses it as the opening
 * turn's submission key (so the turn is admitted once).
 */

import { postJson } from "../runs/api";

export type StartedRun = { id: string };

export function startChatRun(
  firstMessage: string,
  clientRequestId: string
): Promise<StartedRun> {
  return postJson<StartedRun>("/api/runs", { firstMessage, clientRequestId });
}

export type ChatStarter = {
  /** Start a run, or join the attempt already in flight for this text. */
  start(text: string): Promise<StartedRun | null>;
};

/**
 * One create per submission, and ONE `clientRequestId` per text — including
 * across retries.
 *
 * The opposite of `makeSteerSender`'s rule, and deliberately: a steer that
 * failed may never have arrived, so re-asserting it needs a fresh id; a create
 * that failed may have arrived and written a run, so re-asserting it must carry
 * the SAME id or the human ends up with two conversations for one question.
 *
 * Pure, and takes its id source as an argument, so both properties are testable
 * without a network.
 */
export function makeChatStarter(
  post: (text: string, clientRequestId: string) => Promise<StartedRun>,
  mintId: () => string = () => crypto.randomUUID()
): ChatStarter {
  const idFor = new Map<string, string>();
  const inFlight = new Map<string, Promise<StartedRun>>();

  return {
    async start(text: string): Promise<StartedRun | null> {
      const body = text.trim();
      if (body === "") return null;

      const existing = inFlight.get(body);
      if (existing !== undefined) return existing;

      let clientRequestId = idFor.get(body);
      if (clientRequestId === undefined) {
        clientRequestId = mintId();
        idFor.set(body, clientRequestId);
      }

      const attempt = post(body, clientRequestId).finally(() => {
        inFlight.delete(body);
      });
      inFlight.set(body, attempt);
      return attempt;
    },
  };
}
