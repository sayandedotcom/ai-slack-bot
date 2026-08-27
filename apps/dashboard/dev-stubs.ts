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
 * dashboard can be looked at. Everything else — `/api/runs`, `/api/counters` —
 * falls through to the real worker, so the run list is showing genuine D1 data,
 * not a fiction.
 *
 * WHAT DOES NOT WORK ON LOCALHOST, stated rather than papered over. Three
 * surfaces landed in Phase 26 behind the same `requireTeamMember` check, and
 * `wrangler dev` has no Cloudflare Access in front of it, so all three answer
 * 401 here: `POST /api/runs` (start a chat run), `GET /api/runs/:id`, and the
 * run socket at `/api/runs/:id/agent`. The socket is the reason none of them is
 * stubbed. A fake create would hand back an id whose socket then refuses, which
 * looks like a bug in the run view rather than what it is — and a stubbed
 * socket would be a fiction of a live transcript, which is the one thing this
 * file has never done. Exercise them against a deployed Worker behind the real
 * Access application.
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
      draft:
        "Thanks for flagging it — I've reopened the ticket and someone will pick it up today.",
      why: "The thread moved on while this was waiting, so the agent is likely to retract it.",
      channelId: "C0GAMMA",
      threadTs: "1786652222.000300",
      createdAt: now - 8_000,
      updatedAt: now - 8_000,
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
      const approvals = new Map(
        seedApprovals(bootedAt).map((row) => [row.id, row])
      );
      /**
       * The channel registry. Two rows on purpose: one whose customer a human
       * has confirmed, and one still carrying the registrar's guess, because
       * the difference between them is the only thing the panel exists to
       * show. Mutable, so confirming a slug here actually flips `slugSource`.
       */
      const channels = new Map<string, Record<string, unknown>>([
        [
          "C0DEV000001",
          {
            channelId: "C0DEV000001",
            name: "ext-pulsefit",
            customerSlug: "pulsefit",
            mode: "live",
            slugSource: "human",
          },
        ],
        [
          "C0DEV000002",
          {
            channelId: "C0DEV000002",
            name: "ext-acme-corp",
            customerSlug: "ext-acme-corp",
            mode: "live",
            slugSource: "derived",
          },
        ],
        [
          "C0DEV000003",
          {
            channelId: "C0DEV000003",
            name: "eng-internal",
            customerSlug: null,
            mode: "internal",
            slugSource: "derived",
          },
        ],
      ]);
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
      server.middlewares.use((request, response, next) => {
        const url = request.url ?? "";
        const path = url.split("?")[0] ?? "";

        if (path === "/api/identity") {
          // `firefighter` so the approval actions are live. Flip to "viewer" to
          // see the disabled-with-a-reason state the plan grades.
          return send(response, 200, { email: DEV_EMAIL, role: "firefighter" });
        }

        if (path === "/api/roster") {
          return send(response, 200, {
            speaker: { email: DEV_EMAIL },
            githubSpeaker: { email: DEV_EMAIL },
            pool: [DEV_EMAIL, "dana@example.com"],
            engineers: [
              {
                email: DEV_EMAIL,
                role: "firefighter",
                slack: true,
                github: true,
              },
              {
                email: "dana@example.com",
                role: "firefighter",
                slack: true,
                github: false,
              },
              {
                email: "ravi@example.com",
                role: "viewer",
                slack: false,
                github: false,
              },
            ],
          });
        }

        // The channel registry. Stateful across a session so that confirming
        // a slug actually flips `slugSource` in the panel -- the whole point
        // of the control is that a derived slug becomes a confirmed one, and a
        // stub that always replayed "derived" would hide the only state change
        // worth looking at.
        if (path.startsWith("/api/channels")) {
          if (request.method === "GET") {
            return send(response, 200, {
              channels: [...channels.values()],
            });
          }
          if (request.method === "PATCH") {
            const id = decodeURIComponent(path.slice("/api/channels/".length));
            const row = channels.get(id);
            if (row === undefined) {
              return send(response, 404, {
                code: "unknown_channel",
                message: "no such channel",
              });
            }
            void readBody(request).then((body) => {
              const patch =
                (body as { mode?: string; customerSlug?: string | null }) ?? {};

              if (patch.customerSlug !== undefined) {
                if (
                  patch.customerSlug !== null &&
                  !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(patch.customerSlug)
                ) {
                  return send(response, 422, {
                    code: "invalid_patch",
                    message: "malformed slug",
                  });
                }
                row.customerSlug = patch.customerSlug;
                // The provenance moves WITH the slug, exactly as the worker
                // does it -- clearing the customer sends it back to derived.
                row.slugSource =
                  patch.customerSlug === null ? "derived" : "human";
              }
              if (patch.mode !== undefined) row.mode = patch.mode;
              return send(response, 200, row);
            });
            return;
          }
        }

        if (path === "/api/approvals" && request.method === "GET") {
          armWithdrawal();
          const open = [...approvals.values()].filter(
            (row) => row.decision === "pending"
          );
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
          if (!row)
            return send(response, 404, {
              code: "unknown_approval",
              message: "no such approval",
            });

          if (request.method === "GET")
            return send(response, 200, { approval: row });

          if (request.method === "PATCH") {
            void readBody(request).then((body) => {
              const action =
                (body as { action?: string; text?: string; reason?: string }) ??
                {};

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
                if (
                  typeof action.text !== "string" ||
                  action.text.trim() === ""
                ) {
                  return send(response, 422, {
                    code: "invalid_action",
                    message: "edit needs text",
                  });
                }
                row.decision = "edited";
                row.editedText = action.text;
              } else if (action.action === "reject") {
                if (
                  typeof action.reason !== "string" ||
                  action.reason.trim() === ""
                ) {
                  return send(response, 422, {
                    code: "invalid_action",
                    message: "reject needs a reason",
                  });
                }
                row.decision = "rejected";
                row.rejectReason = action.reason;
              } else {
                return send(response, 422, {
                  code: "invalid_action",
                  message: "unknown action",
                });
              }

              return send(response, 200, {
                approval: row,
                resolutionDelivered: false,
              });
            });
            return;
          }
        }

        next();
      });
    },
  };
}
