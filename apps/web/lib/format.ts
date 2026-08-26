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
 * The string is never parsed — this only decides where to put the dollar sign,
 * because `Number()` on a ledger total is a rounded invoice.
 */
export function usd(total: string): string {
  return `$${total}`;
}
