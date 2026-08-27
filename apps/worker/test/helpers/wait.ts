/**
 * Wait for something a Durable Object alarm produced.
 *
 * Every wake path in this codebase ends in `runTurn({ mode: "submit" })`, which
 * returns as soon as the submission row is written and schedules the turn on
 * the object's own alarm. So the observable effects of a wake — the usage row,
 * the projected status, a second turn — land AFTER the call a test awaited, and
 * polling for them is the only way to see them from outside.
 *
 * Bounded and reported: a timeout throws with the predicate's name, so a
 * genuinely broken wake fails as a wake failure rather than as a silent
 * assertion on a stale read.
 */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | null | undefined>,
  options: { attempts?: number; intervalMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 80;
  const intervalMs = options.intervalMs ?? 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}
