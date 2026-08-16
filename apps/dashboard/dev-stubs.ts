import type { ServerResponse } from "node:http";

import type { Connect, Plugin } from "vite";

/**
 * Dev-only stubs for the Cloudflare Access-gated routes.
 *
 * `apps/worker/src/access/jwt.ts` is explicit that there is NO dev-bypass
 * parameter: every identity is proved by a real JWT verified against
 * Cloudflare's JWKS. That is the right call for the worker, and it means
 * `/api/identity`, `/api/roster` and `/api/approvals` cannot answer anything but
 * 401 on localhost — so the SPA renders `SignedOutPage` and no panel is
 * reachable, including the two this phase built.
 *
 * This plugin answers exactly those three route families from memory so the
 * dashboard can be looked at. Everything else — `/api/runs`, `/api/counters`,
 * and the `/ws/run/:id` socket — falls through to the real worker, so the run
 * list and the drawer are showing genuine D1 data, not a fiction.
 *
 * PHASE 25 adds a fourth, and it is OPT-IN rather than always-on. `/api/chassis`
 * and the agent transport under `/agents/*` are NOT Access-gated puzzles — a
 * running `wrangler dev` answers both perfectly well — so faking them by
 * default would replace real data with a fiction for no reason. They are
 * claimed only when `FIREFIGHTER_CHASSIS` is set:
 *
 *   FIREFIGHTER_CHASSIS=think pnpm dev    # look at the useAgentChat view
 *   FIREFIGHTER_CHASSIS=legacy pnpm dev   # look at the /ws view
 *   pnpm dev                              # ask the worker, like production
 *
 * See `agentStubs` at the bottom for what `think` fabricates and, just as
 * importantly, what it cannot: the agent WebSocket is a real upgrade that only
 * a Worker can serve, so with no `wrangler dev` behind it the transcript renders
 * from the canned `/get-messages` reply and the view sits in its reconnect
 * banner. That banner is itself one of the states this task had to build, so
 * being able to see it cold is a feature.
 *
 * It CANNOT reach production: it is a `configureServer` hook, and that hook
 * exists only inside vite's dev server. `vite build` never calls it, so not one
 * line of this file is in the bundle. It is also not a security shortcut
 * anywhere real — the worker still refuses every unauthenticated request; this
 * only changes what the dev server hands back before the proxy sees it.
 */

const DEV_EMAIL = "sayan@example.com";

type StubApproval = {
  id: string;
  runId: string;
  draft: string;
  why: string;
  channelId: string;
  threadTs: string;
  createdAt: number;
  updatedAt: number;
  decision: "pending" | "approved" | "edited" | "rejected" | "withdrawn";
  decidedBy: string | null;
  decidedAt: number | null;
  editedText: string | null;
  rejectReason: string | null;
  delivery: string;
};

function seedApprovals(now: number): StubApproval[] {
  const base = {
    runId: "dev-run",
    decision: "pending" as const,
    decidedBy: null,
    decidedAt: null,
    editedText: null,
    rejectReason: null,
    delivery: "none",
  };
  return [
    {
      ...base,
      id: "apr:dev-1",
      draft:
        "We've rolled back the deploy behind this morning's 502s. No data was affected, and we'll send you a written post-mortem by Friday.",
      why: "Commits the team to a post-mortem on a named day, so a human should sign that off.",
      channelId: "C0ACME",
      threadTs: "1786650000.000100",
      createdAt: now - 90_000,
      updatedAt: now - 90_000,
    },
    {
      ...base,
      id: "apr:dev-2",
      draft:
        "That's expected — the export endpoint is rate limited to 60 requests a minute per token. Raising it for your account is a change we can make, but it needs a quick look from the platform team first.",
      why: "Hints that a limit could be raised for this customer, which is a commitment we have not made.",
      channelId: "C0BETA",
      threadTs: "1786651111.000200",
      createdAt: now - 30_000,
      updatedAt: now - 30_000,
    },
    {
      // Vanishes 25s after boot with nobody having touched it, which is what
      // the agent withdrawing an ask looks like from the dashboard's side. It
      // is here to exercise vanish-reconciliation, the one path that is
      // otherwise very hard to see by hand.
      ...base,
      id: "apr:dev-withdrawn",
      draft: "Thanks for flagging it — I've reopened the ticket and someone will pick it up today.",
      why: "The thread moved on while this was waiting, so the agent is likely to retract it.",
      channelId: "C0GAMMA",
      threadTs: "1786652222.000300",
      createdAt: now - 8_000,
      updatedAt: now - 8_000,
    },
  ];
}

/**
 * Phase 25's opt-in half. `undefined` means "do not claim these routes at all",
 * which is the default and the only setting that shows real data.
 */
function devChassis(): "think" | "legacy" | undefined {
  const configured = process.env.FIREFIGHTER_CHASSIS;
  if (configured === "think" || configured === "legacy") return configured;
  // Named, never echoed — same discipline as the worker's own chassis resolver.
  if (configured !== undefined && configured !== "") {
    console.warn("[dev-stubs] FIREFIGHTER_CHASSIS is not 'think' or 'legacy'; ignoring it");
  }
  return undefined;
}

/**
 * A canned Think transcript: one human turn, one `run_code` call with a
 * `memory.cite`-shaped result nested in its output, one answer.
 *
 * The nesting is the point. On this chassis the model has exactly ONE tool, so
 * cited facts arrive buried inside whatever the model's own code returned —
 * `sourcesFromToolOutput` finds them by shape, and this fixture is what proves
 * the sources rail still fills in without a live agent to ask.
 */
function seedAgentMessages(): unknown[] {
  return [
    {
      id: "msg-dev-1",
      role: "user",
      parts: [{ type: "text", text: "did PulseFit complain about checkout before, and what did we do?" }],
    },
    {
      id: "msg-dev-2",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-run_code",
          toolCallId: "call-dev-1",
          state: "output-available",
          input: {
            code: [
              "const hits = await memory.search({",
              '  customer: "pulsefit",',
              '  query: "checkout failure",',
              "});",
              "return { cited: await memory.cite({ factIds: hits.map((h) => h.factId) }) };",
            ].join("\n"),
          },
          output: {
            status: "completed",
            executionId: "exec-dev-1",
            result: {
              cited: [
                {
                  factId: "fact-dev-1",
                  fact: "PulseFit reported checkout 502s during the 14 Aug deploy window.",
                  permalink: "https://zellify.slack.com/archives/C0ACME/p1786650000000100",
                  ts: "1786650000.000100",
                },
              ],
            },
          },
        },
        {
          type: "text",
          text: "Yes — on 14 August, during the deploy window. We rolled the deploy back and the errors stopped inside four minutes.",
        },
      ],
    },
  ];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(request: Connect.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function devAccessStubs(): Plugin {
  return {
    name: "firefighter-dev-access-stubs",
    apply: "serve",
    configureServer(server) {
      const bootedAt = Date.now();
      const approvals = new Map(seedApprovals(bootedAt).map((row) => [row.id, row]));
      /**
       * The agent's retraction. Armed by the FIRST list request rather than by
       * server boot, so it fires 45s after someone actually opens the page —
       * a timer counting from `vite dev` would usually have expired before the
       * browser was ever pointed at it. `withdrawn` rows leave the open list
       * exactly like a decided one, which is the case the hook has to explain
       * rather than let blink out.
       */
      let withdrawalArmed = false;
      const armWithdrawal = () => {
        if (withdrawalArmed) return;
        withdrawalArmed = true;
        setTimeout(() => {
          const row = approvals.get("apr:dev-withdrawn");
          if (row && row.decision === "pending") {
            row.decision = "withdrawn";
            row.updatedAt = Date.now();
          }
        }, 45_000).unref?.();
      };

      // Registered inside `configureServer` rather than in the function it can
      // return, so these land BEFORE vite's own proxy middleware and win the
      // paths they claim. Everything not claimed here falls through to it.
      const chassis = devChassis();
      if (chassis !== undefined) {
        console.warn(`[dev-stubs] serving /api/chassis as "${chassis}" from memory`);
      }

      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        const path = url.split("?")[0] ?? "";

        // Unset: not claimed, so `wrangler dev` answers and the SPA sees the
        // chassis this checkout would actually deploy.
        if (chassis !== undefined && path === "/api/chassis") {
          return send(response, 200, { chassis });
        }

        // Only the transcript read is faked, and only under `think`. The
        // WebSocket upgrade is deliberately left to fall through: an upgrade
        // needs a Worker, and pretending otherwise would hide the reconnect
        // banner that is one of this view's real states.
        if (chassis === "think" && path.startsWith("/agents/") && path.endsWith("/get-messages")) {
          return send(response, 200, seedAgentMessages());
        }

        if (path === "/api/identity") {
          // `firefighter` so the approval actions are live. Flip to "viewer" to
          // see the disabled-with-a-reason state the plan grades.
          return send(response, 200, { email: DEV_EMAIL, role: "firefighter" });
        }

        if (path === "/api/roster") {
          const hour = 3_600_000;
          return send(response, 200, {
            onDuty: {
              email: DEV_EMAIL,
              index: 0,
              shiftStartMs: bootedAt - hour,
              shiftEndMs: bootedAt + hour * 7,
              nextEmail: "dana@example.com",
            },
            rotation: [DEV_EMAIL, "dana@example.com", "ravi@example.com"],
            engineers: [
              { email: DEV_EMAIL, role: "firefighter", slack: true, github: true },
              { email: "dana@example.com", role: "firefighter", slack: true, github: false },
              { email: "ravi@example.com", role: "viewer", slack: false, github: false },
            ],
          });
        }

        if (path === "/api/approvals" && request.method === "GET") {
          armWithdrawal();
          const open = [...approvals.values()].filter((row) => row.decision === "pending");
          return send(response, 200, {
            approvals: open.map((row) => ({
              id: row.id,
              runId: row.runId,
              draft: row.draft,
              why: row.why,
              channelId: row.channelId,
              threadTs: row.threadTs,
              createdAt: row.createdAt,
            })),
          });
        }

        const detail = /^\/api\/approvals\/(.+)$/.exec(path);
        if (detail) {
          const id = decodeURIComponent(detail[1] as string);
          const row = approvals.get(id);
          if (!row) return send(response, 404, { code: "unknown_approval", message: "no such approval" });

          if (request.method === "GET") return send(response, 200, { approval: row });

          if (request.method === "PATCH") {
            void readBody(request).then((body) => {
              const action = (body as { action?: string; text?: string; reason?: string }) ?? {};

              if (row.decision !== "pending") {
                // The 409 the whole phase is built around. Note what it does
                // and does not carry: a decision, and NO decidedBy — mirroring
                // the worker exactly, so the name-less conflict banner is what
                // you actually see here.
                return send(response, 409, {
                  code: "already_decided",
                  message: "already decided",
                  decision: row.decision,
                });
              }

              row.decidedBy = DEV_EMAIL;
              row.decidedAt = Date.now();
              row.updatedAt = row.decidedAt;
              row.delivery = "blocked";
              if (action.action === "approve") row.decision = "approved";
              else if (action.action === "edit") {
                if (typeof action.text !== "string" || action.text.trim() === "") {
                  return send(response, 422, { code: "invalid_action", message: "edit needs text" });
                }
                row.decision = "edited";
                row.editedText = action.text;
              } else if (action.action === "reject") {
                if (typeof action.reason !== "string" || action.reason.trim() === "") {
                  return send(response, 422, { code: "invalid_action", message: "reject needs a reason" });
                }
                row.decision = "rejected";
                row.rejectReason = action.reason;
              } else {
                return send(response, 422, { code: "invalid_action", message: "unknown action" });
              }

              return send(response, 200, { approval: row, resolutionDelivered: false });
            });
            return;
          }
        }

        next();
      });
    },
  };
}
