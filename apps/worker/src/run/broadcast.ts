import type { RunEvent } from "./protocol";

/**
 * Hand one committed RunEvent to every attached socket.
 *
 * Factored out of `RunDO` because the agent loop's event port needs exactly the
 * same behaviour and must not reimplement it. Two copies of the cursor rule is
 * how one of them ends up skipping a sequence the client never asked for again.
 *
 * `ctx.getWebSockets()` is the recoverable source of connected clients after
 * hibernation. An in-memory Map would be empty after eviction, and the failure
 * would be invisible to any test that never evicts.
 *
 * The per-socket `lastSeq` is what makes an at-least-once replay harmless: an
 * event at or below a socket's cursor was already delivered, so it is skipped
 * rather than shown twice.
 */
export function broadcastEvent(ctx: DurableObjectState, event: RunEvent): void {
  const frame = JSON.stringify({ type: "event", event });
  for (const socket of ctx.getWebSockets()) {
    try {
      const attachment = socket.deserializeAttachment() as { lastSeq?: number } | null;
      const lastSeq = attachment?.lastSeq ?? 0;
      if (lastSeq >= event.seq) continue;

      socket.send(frame);
      socket.serializeAttachment({ ...(attachment ?? {}), lastSeq: event.seq });
    } catch {
      // One broken socket must not fail the mutation for every other client.
    }
  }
}
