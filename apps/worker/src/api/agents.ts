import { Hono } from "hono";
import type { Context } from "hono";
import { getAgentByName } from "agents";

import { requireTeamMember } from "./identity";
import type { Env } from "../index";
import type { RunAgent } from "../run/agent";
import { assertRunKey } from "../run/keys";
import { getRunById } from "../run/repository";
import { AGENT_IDENTITY_HEADER } from "../run/transport";

/**
 * The Agents SDK's own transport for `RunAgent` — the WebSocket the dashboard
 * speaks and the `/get-messages` read behind it — mounted under `/api` so it
 * inherits the dashboard's Access application.
 *
 * MOUNTED UNDER `/api/runs/:id/agent/*`, NOT `/agents/*`, and not through
 * `routeAgentRequest`. Two reasons, and the second one is why the previous
 * build's path rewrite was wrong:
 *
 *  1. `/api` is already behind Access. A new top-level path would be a second
 *     surface to remember to gate, next to `/proofs/*`, which is the ONE path
 *     in this Worker that Access must let through unauthenticated and stays the
 *     only one. An anonymous caller reaching this route would have a live steer
 *     channel into a customer-facing run.
 *  2. `routePartykitRequest` names the object with `idFromName(<path segment>)`
 *     verbatim, so the previous build resolved the id to the key and REWROTE
 *     the path before routing — which put the private run key in the URL the
 *     Durable Object then reads back as `connection.uri`. `getAgentByName`
 *     takes the key as an argument instead, so it never appears in a URL at
 *     all. The browser addresses `runs.id`; D1 answers with the key; the key
 *     stays in the Worker (invariant 10).
 *
 * A caller who guesses a raw run key gets a 404, because a key is not an id.
 */
export const agentsApi = new Hono<{ Bindings: Env }>();

function fail(code: string, message: string) {
  // Code and a generic reason only — these cross to the browser.
  return { code, message };
}

async function forwardToAgent(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const member = await requireTeamMember(c);
  if (member instanceof Response) return member;

  const run = await getRunById(c.env.DB, c.req.param("id") ?? "");
  if (run === null) return c.json(fail("not_found", "no such run"), 404);

  let key: string;
  try {
    // Re-validated before it names an object, exactly as the wake path does: a
    // corrupted `runs.key` must not be able to conjure an anonymous agent.
    key = assertRunKey(run.key);
  } catch {
    return c.json(fail("invalid_run_key", "this run cannot be addressed"), 500);
  }

  // DELETE BEFORE SET, and the order is the whole security of the header. The
  // agent cannot verify an identity that crossed a Durable Object boundary, so
  // a client-supplied copy of this header would be indistinguishable from the
  // one this line writes after `requireTeamMember` verified the Access JWT.
  const headers = new Headers(c.req.raw.headers);
  headers.delete(AGENT_IDENTITY_HEADER);
  headers.set(AGENT_IDENTITY_HEADER, member.email);

  const stub = await getAgentByName<Env, RunAgent>(c.env.RUN_AGENTS, key);
  return stub.fetch(new Request(c.req.raw, { headers }));
}

// Both shapes: the socket connects to the bare base path (partysocket builds
// `${host}/${basePath}`), and `/get-messages` and any future sub-path hang off
// it. Think serves the transcript on this same path, so that read inherits the
// gate above rather than needing one of its own.
agentsApi.all("/runs/:id/agent", forwardToAgent);
agentsApi.all("/runs/:id/agent/*", forwardToAgent);
