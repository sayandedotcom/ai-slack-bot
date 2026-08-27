import { demoShadowPairs } from "../fixtures/shadow";
import { fixture, getJson, isDemo } from "./client";

/** A detected AI "tell" in a draft — the worker's tell detector owns the full list. */
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

/** What each tell means, for the badge tooltips. One line, no jargon. */
export const TELL_MEANING: Record<AiTell, string> = {
  preamble: "Opens by restating the question instead of answering it",
  great_question: "Compliments the asker before saying anything useful",
  bulleted_recap: "Summarises the thread back at people who were in it",
  closing_restatement: "Ends by repeating what it already said",
  exclaimed_thanks: "Thanks the customer with an exclamation mark",
  em_dash: "Em dash — rare in how this team actually writes",
  semicolon: "Semicolon; rare in how this team actually writes",
  emoji: "Emoji in a reply where the team would not use one",
  exclamation: "Exclamation mark in a reply the team would keep flat",
};

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

export async function getShadowPairs(): Promise<ShadowPair[]> {
  if (isDemo()) return fixture(demoShadowPairs);
  const body = await getJson<{ pairs: ShadowPair[] }>(
    "/api/eval/shadow?limit=20"
  );
  return body.pairs;
}
