/**
 * What a browser is allowed to say to a run, over the socket.
 *
 * The Agents SDK gives a connection two ways in — protocol FRAMES and
 * `@callable` RPC — and `shouldConnectionBeReadonly` gates neither of the ones
 * that matter. It stops a client writing `this.state` and nothing else
 * (`agents/dist/index.js:865`), so Think still honours `chat-request`, `clear`,
 * `cancel`, `tool-result` and `tool-approval` from ANY connection. Each of
 * those is a way to drive the run that goes around every control this codebase
 * has: a `chat-request` starts a turn with client-authored text and no input
 * revision, a `clear` wipes a customer conversation's transcript, and a
 * `tool-approval` answers an approval that the dashboard is supposed to answer
 * through the audited D1 route.
 *
 * So the frames are dropped, and human input enters through exactly one
 * `@callable` method: `steer`.
 *
 * `cf_agent_state` is deliberately NOT in the list. Readonly already refuses it
 * with a `cf_agent_state_error` the client can see, and a visible refusal beats
 * a silent drop for the one frame a legitimate client might send by accident.
 */

/** Frames Think acts on that a browser must not be able to send. */
export const BLOCKED_CLIENT_FRAMES: readonly string[] = [
  // Starts a turn with client-authored text. `steer` is the only door.
  "cf_agent_use_chat_request",
  // Wipes the transcript of a customer conversation.
  "cf_agent_chat_clear",
  // Aborts a turn somebody else is waiting on. `cancel` is the audited door.
  "cf_agent_chat_request_cancel",
  // Answers a tool call on the model's behalf.
  "cf_agent_tool_result",
  // Answers an approval outside the D1 route that records who decided.
  "cf_agent_tool_approval",
];

/**
 * Should this inbound frame be dropped before Think ever sees it?
 *
 * Binary frames and unparseable text are passed through: this is an allowlist
 * of things to REFUSE, not a parser, and a frame this cannot read is a frame it
 * cannot claim to have understood.
 */
export function isBlockedClientFrame(message: unknown): boolean {
  if (typeof message !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && BLOCKED_CLIENT_FRAMES.includes(type);
}

/**
 * The header the agent route stamps with the verified Access identity.
 *
 * It crosses a Durable Object boundary, so the agent cannot verify it itself —
 * which is why the route STRIPS any inbound copy before setting its own. The
 * only writer is `src/api/agents.ts`, after `requireTeamMember` has verified
 * the Access JWT and found the caller on the roster.
 */
export const AGENT_IDENTITY_HEADER = "x-firefighter-identity";

/** The verified viewer's email off an upgrade request, or null. */
export function identityFromRequest(request: Request): string | null {
  const email = request.headers.get(AGENT_IDENTITY_HEADER);
  return email !== null && email !== "" ? email : null;
}
