import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import { ensureSchema } from "./session";

/**
 * The thread-scoped run. One object per origin key — `slack:{channel}:{thread}`
 * or `chat:{uuid}` — reached only through `runStubForKey()`.
 *
 * Task 3 establishes the durable schema. The RPC surface, the D1 index write
 * and the hibernating WebSocket protocol arrive in Tasks 4, 5a and 5b.
 */
export class RunDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Synchronous only. Constructor work runs again on every wake from
    // hibernation, so it must be cheap and must not await anything.
    ensureSchema(ctx.storage);
  }
}
