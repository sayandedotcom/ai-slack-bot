import type { UserModelMessage } from "ai";
import { isWakeSource } from "../contracts";
import type { RunTurn, TurnSource } from "../../run/protocol";

/**
 * The untrusted half of the prompt: how a customer/triage/Slack/memory/tool
 * value becomes a model message without becoming an instruction.
 *
 * TWO THINGS CARRY THE SECURITY HERE, AND THE DELIMITER IS NEITHER OF THEM.
 *
 * 1. **Role separation.** Every value in this file becomes a `role: "user"`
 *    message. That is the authority boundary (invariants 23 and 25). A system
 *    message is something we wrote; a user message is something we received.
 *
 * 2. **A losslessly round-trippable frame.** The plan sketches an XML-ish
 *    `<untrusted_input source="…">…</untrusted_input>` wrapper and says
 *    explicitly that it is READABILITY, not a security primitive (plan line
 *    ~925). It is worth saying why, because the sketch is tempting: a body
 *    containing the literal bytes `</untrusted_input>` closes its own wrapper,
 *    and the usual answer — escape the sequence on the way in — is an escaping
 *    scheme, which is the thing that gets quietly wrong. So the frame is JSON.
 *    A `}` inside a JSON string cannot terminate the object that contains it,
 *    because JSON's own grammar is doing the containment, and `JSON.parse` of
 *    `JSON.stringify` returns the original bytes for every possible string.
 *
 * The test that matters is therefore `decode(encode(text)) === text`, not
 * "the serialized prompt contains these literal bytes".
 */

/**
 * Bumped only if the envelope's SHAPE changes.
 *
 * It is in the payload rather than implied because a stored transcript outlives
 * a deploy: a message written by an older build is read back by a newer one, and
 * "which shape is this" must not be guessed from which keys happen to be
 * present.
 */
export const EVIDENCE_ENVELOPE_VERSION = 1;

/**
 * One piece of evidence, as the model sees it.
 *
 * The metadata fields are TRUSTED — we assign them — and the body is not. That
 * asymmetry is the entire point of the envelope: an opaque id the model can
 * quote back to us, attached to bytes it must treat as a report of what somebody
 * said rather than as something to obey.
 *
 * Deliberately absent: the Slack channel id, the thread ts, the run key, the
 * author's Slack user id, and the permalink. None of them is needed to reason
 * about the content, all of them are either a routing coordinate the model must
 * not select (plan: "fixed Slack-target presence, not a model-selectable
 * channel ID") or the Durable Object's own name.
 */
export type UntrustedEvidence = {
  version: number;
  /** Provenance. Assigned by the host, never parsed out of the body. */
  source: TurnSource;
  /** The turn's stable id (`triage:{event}`, `slack:{event}`, …). Opaque. */
  turnId: string;
  /** RunEvent sequence. Trusted ordering metadata (invariant 12). */
  eventSeq: number;
  /** The untrusted bytes, verbatim. */
  body: string;
};

/** What the JSON envelope looks like on the wire. Snake_case reads as data. */
type EvidenceEnvelope = {
  untrusted_input: {
    version: number;
    source: TurnSource;
    turn_id: string;
    event_seq: number;
    body: string;
  };
};

export class PromptAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptAuthorityError";
  }
}

/**
 * Frame one untrusted value. Total over every possible `body`, including one
 * that contains the delimiter this envelope replaced.
 */
export function encodeUntrustedEvidence(input: {
  source: TurnSource;
  turnId: string;
  eventSeq: number;
  body: string;
}): string {
  const envelope: EvidenceEnvelope = {
    untrusted_input: {
      version: EVIDENCE_ENVELOPE_VERSION,
      source: input.source,
      turn_id: input.turnId,
      event_seq: input.eventSeq,
      body: input.body,
    },
  };
  return JSON.stringify(envelope);
}

/**
 * The inverse. Returns null rather than throwing for anything that is not one
 * of our envelopes: this runs over durable rows, and a shape from a future build
 * is a thing to skip, not a reason to fail a customer's answer.
 */
export function decodeUntrustedEvidence(text: string): UntrustedEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const inner = (parsed as { untrusted_input?: unknown }).untrusted_input;
  if (typeof inner !== "object" || inner === null) return null;

  const record = inner as Record<string, unknown>;
  if (typeof record.body !== "string") return null;
  if (typeof record.source !== "string") return null;
  if (typeof record.turn_id !== "string") return null;
  if (typeof record.event_seq !== "number") return null;
  if (typeof record.version !== "number") return null;

  return {
    version: record.version,
    source: record.source as TurnSource,
    turnId: record.turn_id,
    eventSeq: record.event_seq,
    body: record.body,
  };
}

/**
 * A committed turn, as a model message.
 *
 * ALWAYS `role: "user"`, and the stored `turn.role` is deliberately not
 * consulted for the outgoing role. That is the compatibility mapper the fix in
 * `run/coordinator.ts` needs: every triage opening written before that fix sits
 * in a durable table saying `role: "system"`, and those runs are still live.
 * Reading the stored role would keep handing those rows system authority for the
 * rest of their conversation, which would make the fix apply to new runs only —
 * exactly the half-fix invariant 23 forbids.
 *
 * The `assistant` role is refused rather than downgraded. The loop's own output
 * arriving here as input is a bug in the caller, and turning it into a user
 * message would make the model answer itself.
 */
export function toInputModelMessage(turn: RunTurn, eventSeq: number): UserModelMessage {
  if (!isWakeSource(turn.source)) {
    // `agent` and `system` sources are the loop's own output and operational
    // noise. Operational events are not model context (invariant 22).
    throw new PromptAuthorityError(
      `turn ${turn.id} has source ${turn.source}, which is not conversational input`,
    );
  }
  if (!Number.isInteger(eventSeq) || eventSeq <= 0) {
    throw new PromptAuthorityError(`turn ${turn.id} has no usable event sequence`);
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: encodeUntrustedEvidence({
          source: turn.source,
          turnId: turn.id,
          eventSeq,
          body: turn.content,
        }),
      },
    ],
  };
}

/**
 * True for a stored turn that predates the coordinator fix and would have had
 * system authority.
 *
 * Exported so a test can assert the downgrade on a row shaped exactly like the
 * ones already in production, rather than on a row a test invented.
 */
export function isLegacySystemAuthorityTurn(turn: RunTurn): boolean {
  return turn.role === "system" && isWakeSource(turn.source);
}
