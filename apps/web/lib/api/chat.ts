import { fixture, isDemo, postJson } from "./client";
import { DEMO_CHAT_RUN_ID } from "../fixtures/run-transcript";

/**
 * Starting a run from this app.
 *
 * A chat run is the SAME object a Slack wake produces — one `RunAgent`, one
 * transcript, one steer path — so there is no second session shape here. This
 * module creates the run; everything after that is the run view, over the
 * socket in `lib/hooks/use-run-agent.ts`.
 *
 * `POST /api/runs` landed in the Worker with the Agents-SDK chassis
 * (`apps/worker/src/api/runs.ts`). Viewers may reach it: a chat run has no
 * customer thread, nothing it says goes out under anyone's name, and every
 * committal write is still gated by `PATCH /api/approvals/:id`.
 */

/** What the Worker will accept as an opening message (`CHAT_FIRST_MESSAGE_MAX_CHARS`). */
export const FIRST_MESSAGE_MAX_CHARS = 4_000;

export type StartedRun = { id: string };

export function startChatRun(
  firstMessage: string,
  clientRequestId: string,
): Promise<StartedRun> {
  if (isDemo()) return fixture({ id: DEMO_CHAT_RUN_ID });
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
 * The opposite of the steer sender's rule, and deliberately. A steer that
 * failed may never have arrived, so re-asserting it needs a fresh id. A create
 * that failed may have arrived and written a run, so re-asserting it must carry
 * the SAME id, or the human ends up with two conversations for one question.
 * The Worker derives the run's key from this id, so a retry resolves to the run
 * the first attempt made.
 *
 * Pure, and takes its id source as an argument, so both properties are testable
 * without a network.
 */
export function makeChatStarter(
  post: (text: string, clientRequestId: string) => Promise<StartedRun>,
  mintId: () => string = () => crypto.randomUUID(),
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
