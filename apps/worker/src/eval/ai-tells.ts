/**
 * Mechanical detection of the AI tells the Voice section of
 * `src/agent/prompt/policy.ts` bans in customer-facing copy.
 *
 * This module encodes the spec's EXISTING copy rules. It does not invent new
 * taste: every pattern below is commented with the exact policy line (or
 * brief step) it enforces, and nothing is flagged that policy.ts does not
 * itself ban.
 *
 * Design constraints (deliberate, not an oversight):
 * - Fixed pattern tables only. No NLP, no scoring, no fuzzy matching, no new
 *   dependencies. A tell is present or it is absent.
 * - Case-insensitive throughout, since a model drafting in Title Case is as
 *   much a tell as one drafting lower case.
 * - A near-miss — text that superficially resembles a tell but is not on the
 *   fixed list — is deliberately left alone. See `PREAMBLE_OPENERS` below for
 *   why that matters most for `preamble`.
 */

/**
 * The nine AI tells this module can detect.
 *
 * The first five come from the brief's Step 1 (structural/rhetorical tells).
 * The last four ("_em_dash" through "exclamation") come from Step 3b, added
 * to match the typography rules `policy.ts` gained on 2026-08-14 (no em dash,
 * no semicolon, no emoji, no exclamation mark). The detector and the policy
 * must ban exactly the same things, or a draft can pass one and fail the
 * other — see the controller ruling recorded in task-2-report.md.
 */
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

/**
 * Fixed greeting-openers that mark a draft as `preamble`.
 *
 * Policy ("Voice"): 'No preamble. No "Great question!", no "I\'d be happy to
 * help", no "Thanks for flagging this!".' ("Great question" and exclaimed
 * "Thanks for flagging" get their own, more specific tells below —
 * `great_question` and `exclaimed_thanks` — so this list covers the rest of
 * that sentence and its obvious siblings.)
 *
 * THIS LIST IS THE RULE, not an approximation of one. `preamble` matches only
 * when the text (after trimming leading whitespace) starts with one of these
 * exact openers. A reply that merely starts with the word "Thanks" before
 * real substance — e.g. "Thanks, that matches what we saw in the logs too."
 * — is a near-miss and is deliberately NOT flagged: it is not on the list,
 * and the whole point of a fixed pattern table is that there is nothing to
 * weigh up about whether it "counts." Extending this list is a reviewed,
 * deliberate change to the rule, not a bug fix.
 */
const PREAMBLE_OPENERS: readonly RegExp[] = [
  /^thanks for reaching out\b/i,
  /^thank you for reaching out\b/i,
  /^i['’]?d be happy to help\b/i,
  /^i would be happy to help\b/i,
  /^happy to help\b/i,
  /^i['’]?m happy to help\b/i,
];

/**
 * Policy ("Voice"): no "Great question!". Brief Step 1: case-insensitive
 * "great/good question", anywhere in the text (it is a preamble whether or
 * not it opens the message).
 */
const GREAT_QUESTION_RE = /\b(great|good)\s+question\b/i;

/**
 * Policy ("Voice"): "No headers, and no bullet list where two sentences would
 * do." / "No recap of what was just said back at the person who said it."
 * Brief Step 1: a bullet list whose INTRO line contains "summarize"/"recap".
 *
 * A line is an intro line if it is not itself a bullet line. `bulleted_recap`
 * fires only when such a line contains the word and a bullet list follows it
 * — a summary sentence with no list ("To summarize, the fix is out.") is a
 * near-miss and is left alone, and so is a plain bullet list with a
 * non-recap intro ("Two things:\n- a\n- b").
 */
const RECAP_WORD_RE = /\b(summar(?:y|ize|ise)|recap)\b/i;
const BULLET_LINE_RE = /^[ \t]*[-*•][ \t]+/;

function hasBulletedRecap(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (BULLET_LINE_RE.test(line)) continue; // a bullet line is never itself the intro
    if (!RECAP_WORD_RE.test(line)) continue;
    const followedByBullet = lines.slice(i + 1).some((l) => BULLET_LINE_RE.test(l));
    if (followedByBullet) return true;
  }
  return false;
}

/**
 * Policy ("Voice"): "No closing paragraph restating the answer, and no offer
 * to help further." Brief Step 1: "Let me know if you have any other
 * questions", "Hope this helps" closers.
 *
 * Fixed phrase list, matched anywhere in the text (case-insensitive
 * substring). "I'll post here if it regresses" is a near-miss: it commits to
 * a concrete follow-up rather than restating or offering generic help, so it
 * is not on the list.
 */
const CLOSING_RESTATEMENT_PHRASES: readonly string[] = [
  "let me know if you have any other questions",
  "let me know if you have any questions",
  "please let me know if you have any other questions",
  "hope this helps",
  "don't hesitate to reach out",
  "do not hesitate to reach out",
  "feel free to reach out",
];

/**
 * Policy ("Voice"): 'No preamble. No ... "Thanks for flagging this!".' /
 * "No exclamation marks." Brief Step 1: "Thanks for flagging!" —
 * exclamation-marked gratitude specifically, distinct from a plain "!" and
 * distinct from unexclaimed thanks ("Thanks for flagging this." is fine on
 * this axis, though the em-dash/semicolon/etc. rules still apply to it).
 */
const EXCLAIMED_THANKS_RE = /\b(thanks|thank you)\b[^.?!]*!/i;

/**
 * Typography rules added to policy.ts on 2026-08-14 ("Voice" > "Punctuation
 * and rhythm"), Step 3b of the brief.
 *
 * `EM_DASH_RE` also matches an en dash (U+2013): "Never use an em dash. ...
 * Same for an en dash between words." There is no separate `en_dash` member
 * in the nine-member `AiTell` union the controller ruling specifies, so the
 * en-dash-between-words case is folded into `em_dash` rather than silently
 * dropped — see task-2-report.md.
 */
const EM_DASH_RE = /[—–]/; // — or –
/** "Never use a semicolon. Write two sentences." */
const SEMICOLON_RE = /;/;
/** "Never use an emoji. Not in a reply, not in a draft, not anywhere a customer can see. No emoticons either." */
const EMOJI_RE = /\p{Extended_Pictographic}/u;
/** "No exclamation marks. A full stop carries everything you need." */
const EXCLAMATION_RE = /!/;

/**
 * Blanks out code spans before matching.
 *
 * Policy ("Voice" > "Punctuation and rhythm"): "These rules are about prose,
 * not code. Inside backticks or a fenced block, write the code as it actually
 * is." This agent supports a codebase, so a customer-facing reply routinely
 * carries a shell one-liner or a SQL statement. Without this, `git log;
 * git status` scores a `semicolon`, `a !== b` scores an `exclamation`, and a
 * pasted log line carrying a warning glyph scores an `emoji` — inflating the
 * tell rate with drafts that are obeying the policy, not breaking it.
 *
 * Code is replaced with spaces rather than removed, so offsets and — more to
 * the point — LINE STRUCTURE survive. `hasBulletedRecap` reasons about which
 * line a bullet is on, and deleting a fenced block outright would let an intro
 * line collide with a bullet that was never adjacent to it.
 */
function stripCode(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * Detects which of the nine mechanical AI tells appear in `text`. Present or
 * absent only — no severity, no score. `[]` means the text is clean.
 *
 * Matching runs against the text with code spans blanked out; see `stripCode`.
 */
export function detectAiTells(source: string): AiTell[] {
  const text = stripCode(source);
  const tells: AiTell[] = [];
  const trimmed = text.replace(/^\s+/, "");

  if (PREAMBLE_OPENERS.some((re) => re.test(trimmed))) tells.push("preamble");
  if (GREAT_QUESTION_RE.test(text)) tells.push("great_question");
  if (hasBulletedRecap(text)) tells.push("bulleted_recap");
  if (CLOSING_RESTATEMENT_PHRASES.some((phrase) => text.toLowerCase().includes(phrase))) {
    tells.push("closing_restatement");
  }
  if (EXCLAIMED_THANKS_RE.test(text)) tells.push("exclaimed_thanks");
  if (EM_DASH_RE.test(text)) tells.push("em_dash");
  if (SEMICOLON_RE.test(text)) tells.push("semicolon");
  if (EMOJI_RE.test(text)) tells.push("emoji");
  if (EXCLAMATION_RE.test(text)) tells.push("exclamation");

  return tells;
}
