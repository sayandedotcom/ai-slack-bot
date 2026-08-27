/**
 * The shadow-eval half of the dashboard's network surface. One read, over the
 * Phase 14 client — no test file here, this is a one-liner over a route
 * that is already tested at the worker layer.
 */

import { getJson } from "../lib/api";

/** A detected AI "tell" in a draft — see the worker's tell detector for the full list. */
export type AiTell =
  | "preamble"
  | "great_question"
  | "bulleted_recap"
  | "closing_restatement"
  | "exclaimed_thanks"
  | "em_dash"
  | "semicolon"
  | "emoji"
  | "exclamation";

export type HumanReply = {
  text: string;
  permalink: string | null;
  ts: string;
};

export type ShadowPair = {
  approvalId: string;
  draft: string;
  why: string;
  createdAt: number;
  channelId: string;
  threadTs: string;
  tells: AiTell[];
  humanReply: HumanReply | null;
};

export async function fetchShadowPairs(): Promise<ShadowPair[]> {
  const body = await getJson<{ pairs: ShadowPair[] }>(
    "/api/eval/shadow?limit=20"
  );
  return body.pairs;
}
