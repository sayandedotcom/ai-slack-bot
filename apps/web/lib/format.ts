/**
 * Coarse on purpose. Lists re-render on a five-second poll, so a
 * second-accurate string would be as precise as the data underneath it;
 * seconds would flicker and imply a freshness the poll cannot back.
 *
 * The signature matches the Vite dashboard's exactly so the two front-ends can
 * never disagree about what "now" means for the same row.
 */
export function ago(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The local-part is what people call each other; the domain is noise on screen. */
export function nameOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

export function initialOf(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

/**
 * A Slack thread key as it is worth showing: the seconds part only. The full
 * `1787734021.000400` is an identifier nobody reads; the last six digits are
 * what distinguishes two threads in the same minute.
 */
export function shortThread(threadTs: string): string {
  return threadTs.length > 8 ? `…${threadTs.slice(-6)}` : threadTs;
}

/**
 * A cost as it should be shown, from the decimal string the ledger returned.
 *
 * `decimalNanoUsd` (`apps/worker/src/run/money.ts`) always pads to nine
 * decimal places, so a real row is `"0.412700000"` — unreadable verbatim, and
 * false precision nobody asked for. This truncates to four decimal places BY
 * STRING SLICE — never `Number()`, never `parseFloat`, never `toFixed`. Money
 * is a decimal string end to end (invariant 29); parsing it here is the exact
 * trap that invariant exists to prevent. Truncating rather than rounding means
 * a displayed cost never overstates what was actually spent. Callers that want
 * the untruncated figure still have `total` itself — put it in a `title`
 * attribute so the exact value is one hover away.
 */
export function usd(total: string): string {
  const negative = total.startsWith("-");
  const unsigned = negative ? total.slice(1) : total;
  const dot = unsigned.indexOf(".");
  const truncated = dot === -1 ? unsigned : unsigned.slice(0, dot + 5);
  return `${negative ? "-" : ""}$${truncated}`;
}
