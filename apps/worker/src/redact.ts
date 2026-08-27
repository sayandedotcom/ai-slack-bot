/**
 * Pattern-based scrubbing for prose that leaves the Worker.
 *
 * Lifted out of `betterstack/client.ts`, where these patterns were written for
 * log lines another system produced. They apply unchanged to a second problem
 * with the same shape: agent prompts and completions on their way to the
 * LangSmith trace sink (`langsmith/tracer.ts`). One home, so a pattern added
 * for either sink covers both, and one target for the canary sweep.
 *
 * Defense in depth ONLY. This is a denylist over free text, so it catches
 * credential SHAPES we know about and nothing else. It is not a substitute for
 * not putting a secret in the string, which is what invariant 39 actually
 * requires and what every producing surface enforces separately.
 *
 * `String.replace` with a `g` regex does not consult `lastIndex`, so sharing
 * these compiled patterns across calls is safe. `test`/`exec` would not be.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  // `Bearer` FIRST, and the header pattern consumes to end of line. Both are
  // fixes for one hole, found by `test/langsmith-tracer.test.ts` and present in
  // the original `betterstack/client.ts` version of this list:
  //
  //   "Authorization: Bearer abcdefghijklmnop"
  //
  // The header pattern's old `\S+` matched the single token `Bearer` and
  // rewrote the line to "Authorization: [redacted] abcdefghijklmnop" — the
  // word was redacted and the CREDENTIAL was left in place. Worse, having eaten
  // `Bearer`, it stopped the next pattern from matching. Running `Bearer` first
  // catches the value, and `[^\n]+` means the header form takes the whole value
  // rather than its first whitespace-delimited word (`Cookie: a=1; b=2` used to
  // keep `b=2`).
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [redacted]"],
  [/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\n]+/gi, "$1: [redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]"],
  [/\b(sk|lin_api|lsv2_pt|sb_secret)[-_][A-Za-z0-9-]{8,}/g, "[redacted-key]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, "[redacted-email]"],
];

/**
 * Scrub known credential shapes out of one string.
 *
 * ORDER MATTERS at the call site: scrub BEFORE bounding, never after. Cutting
 * a string first can leave a prefix the pattern no longer matches — `xoxb-ab`
 * is not a token to the regex but is still the head of one to a reader.
 */
export function redact(message: string): string {
  return REDACTIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    message
  );
}
