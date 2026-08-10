# Tech Stack

Every technology in the Fire-Fighter build, what it does, and why it was chosen over the alternative. Decisions trace back to `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md`; phase numbers refer to `docs/superpowers/plans/00-roadmap.md`.

Choices marked *adopted from `agent-os`* came from reading Ronit's own repos — see `docs/inspired-from-ronit.md` for full attribution.

---

## Cloudflare — the runtime, and almost everything else

| Tech | What it does here | Phase |
|---|---|---|
| **Workers** | The single origin. Serves the SPA, the API, the Slack webhook, OAuth callbacks, and the WebSocket upgrade. One `wrangler deploy` ships the whole product. | 01 |
| **Workers Assets** | Hosts the built dashboard SPA off the same origin — no CORS, no second deploy target, one Access application. | 01, 14 |
| **Queues** | Decouples the 3-second Slack webhook from the real ingest work. Producer and consumer are the same Worker; the split that matters is request path vs. queue path, not Worker vs. Worker. | 01, 04 |
| **D1** (SQLite) | **The system of record.** Every message verbatim with its permalink, every run, every approval, every identity. Citations resolve through here, which is what makes them correct rather than merely plausible. | 01, 04 |
| **Durable Objects** | One `RunDO` per run, keyed `slack:{channel}:{thread_ts}` or `chat:{uuid}`. Holds the session in its own SQLite, streams over WebSocket, and hibernates at zero cost while an approval sits pending. | 08 |
| **Worker Loader** ⚠️ | **Tier 1 execution.** Runs model-authored TypeScript in an isolate with **no `fetch`** — its only reach is RPC bindings held by the parent Worker. This is the entire credential story at Tier 1. Beta. | 09 |
| **Cloudflare Sandbox** ⚠️ | **Tier 2 execution.** A `standard-4` container (4 vCPU / 12 GiB / 20 GB) the agent boots *itself* to clone the monorepo, run the dev server, drive a browser, and emit a diff. Holds zero write credentials. | 18, 19 |
| **R2** | Stores Playwright proof recordings. A public R2 link goes in both the PR body and the Slack reply — and needs no Slack `files:write` scope, sidestepping a scope that may not be grantable. | 19 |
| **AI Gateway** | Sits in front of Anthropic. Near-free cost tracking, caching, rate limiting and observability — and a cost breakdown against the $500 ceiling is a graded README deliverable. Adopted from `agent-os`. | 07, 10 |
| **Cloudflare Access** | The login gate. One self-hosted application, policy `@zellify.app` plus a temporary personal override. `/slack/*` and `/oauth/*` are bypassed, because Slack cannot authenticate to Access. | 05 |

⚠️ **Thin training data.** Phase 00 exists to verify these two empirically before any production code rests on them. A coding agent will confidently invent APIs for both.

---

## Models

| Tech | What it does here | Cost |
|---|---|---|
| **Claude Haiku 4.5** | Triage. Reads each customer-channel message plus its thread and a memory recall block, emits `{ wake, why, opening_prompt }`. **Never a ticket type** — a `type` field would smuggle the banned pipeline back in. | ~$0.0003/msg → **< $1/week** |
| **Claude Fable 5** | The agent. One tool: write TypeScript. Drafts replies, reasons about bugs, decides when to escalate. | **$20–80/week** |

The brief's instruction stands: spend tokens on the strongest model rather than optimizing the bill.

---

## Memory

| Tech | What it does here | Cost |
|---|---|---|
| **Zep V3** (Graphiti) | The recall layer — **not** the record. A temporal knowledge graph with fact validity windows, so "PulseFit was on the legacy funnel *until March*" is representable rather than flattened. Partitioned as `customer:{slug}` graphs plus one `org` graph holding internal channels, runs, drafts and approval outcomes. | **$25/mo Flex** |

**Chosen over Honcho**, which is built around modeling an individual person's psychology — the wrong shape for "what did we learn about this account." Explicitly not Supermemory, per the brief.

**Version trap:** Zep V3 renamed V2's "groups" to "graphs" (`graph.create()`), and the February 2026 deprecation wave removed parameters such as `min_score` from `graph.search()`. V2-shaped code looks correct and fails. Phase 06 opens with a verification task.

---

## Frontend

| Tech | What it does here |
|---|---|
| **Vite + React 19** | The two-page dashboard. SSR buys nothing when every pixel is live socket state. |
| **shadcn/ui + Tailwind 4** | Components, from the existing `packages/ui`. Nobody grades CSS, but loading, empty and error states have to exist. |
| **Hono** | Routing inside the Worker — webhook, API, OAuth callbacks, WebSocket upgrade, and the asset fallback. |
| **`packages/protocol`** | Wire types shared across the dashboard↔Worker WebSocket boundary, so the run protocol is typed on both ends. The one thing that genuinely justifies the monorepo. Adopted from `agent-os`. |

## Agent runtime

| Tech | What it does here |
|---|---|
| **Vercel AI SDK** + `@ai-sdk/anthropic` | The model client. Streaming, the tool loop, and structured output come free, and the Cloudflare Agents SDK expects it. Adopted from `agent-os`. |

---

## Zellify's integrations

All reached by the model as **typed bindings**, never as raw credentials. The generated `.d.ts` for these bindings is injected into the system prompt, so the types the model sees cannot drift from the types that exist.

| Tech | What the agent uses it for |
|---|---|
| **Slack Web API** | Read threads; post as the on-duty engineer (user token); nudge them (bot token). One app carries both. |
| **GitHub REST** | Open PRs as the fire-fighter, Worker-side, from a diff. `openPR()` takes a **diff**, not a repo handle — the credential topology expressed in a type signature. |
| **Linear** | File and update issues. Team id pinned server-side to `fire-fighter-testing`; the agent cannot choose it. |
| **Supabase** (prod, read-only) | The customer's real data while debugging. Writes are rejected by the database role, not by application logic. |
| **LangSmith** | Pull a trace when a customer says our AI did something weird. |
| **Better Stack** | Logs and uptime when something looks broken in prod. |
| **Playwright** | Reproduce the bug in a real browser, verify the fix, and `recordVideo` the proof. |

---

## Tooling

- **TypeScript** — `strict: true` throughout
- **pnpm 10.33.4** + **Turborepo** — the workspace as handed over
- **Vitest + `@cloudflare/vitest-pool-workers`** — tests run in the real workerd runtime against real D1 and real queues, not mocks
- **Wrangler 4.120**
- **Node 22.20**

---

## Deliberately not used

The rejections are as load-bearing as the choices.

| Rejected | Why |
|---|---|
| **Vercel + Next 16** | The sanctioned combo, and permitted rather than mandated. But every pixel is live socket state, so SSR earns nothing; two origins means cross-origin WebSocket auth against Access and a second deploy target; and Vercel behind an orange-cloud proxy has known cert-issuance friction. Single origin collapses all of it. |
| **`@cloudflare/think`** | Its execution ladder is exactly the right model and is cited as prior art for the two-tier design. But it is a preview release, and a preview base class on a 7-day clock is where the week disappears. Built on stable `agents` + `@cloudflare/codemode` + `@cloudflare/sandbox` instead. |
| **MCP servers as the model's tool surface** | Code Mode instead. LLMs have trained on real-world code and only synthetic tool-call examples. Writing TypeScript lets the agent chain four bindings in one execution without every intermediate result round-tripping through the model. |
| **Flat tool schemas** | Same reasoning, worse: dozens of schemas to maintain by hand, and a contract that drifts from the implementation. The `.d.ts` is generated from the bindings. |
| **Slack Socket Mode** | The app does carry a `connections:write` app-level token, so it is available. But a Worker already has a public HTTPS endpoint, and Socket Mode would need a Durable Object holding a persistent WebSocket to Slack for no benefit. The brief specifies the Events webhook. |
| **E2B / Fly Machines** | Real candidates. Cloudflare Sandbox wins on same-account billing, lifecycle bound to the RunDO, `tunnels.get(port)` for preview URLs, copy-on-write snapshots, and a WebSocket terminal that feeds the live-run view for free. Falls back to E2B if Phase 00 returns NO-GO. |

---

## Cost

| Item | Estimate |
|---|---|
| Triage — Haiku 4.5, ~150–300 msg/day @ $0.0003 | < $1 / week |
| Main agent — Claude Fable 5, ~40 runs | $20 – 80 |
| Zep Flex | $25 / month |
| Cloudflare Workers Paid | $5 |
| Cloudflare Containers usage | $10 – 40 |
| D1 / R2 / Queues / Durable Objects | < $5 |
| Vercel | $0 — not used |
| **Total** | **~$70 – 160** |

Ceiling is $500 all-in for the week, tokens included. Ping Ronit *before* crossing it.

**Accounts needed on your own card** (reimbursed, keep receipts): Anthropic, Cloudflare (**Workers Paid** — Durable Objects and Containers both require it), Zep.

---

## Security properties, by construction

Each of these is a property of the topology rather than a rule someone has to keep following — which is what lets the README's security section match the code.

1. **Tier 1 has no network.** The Worker Loader isolate cannot `fetch`. Model-authored code cannot read a credential because no credential exists in its address space.
2. **Tier 2 holds no write credentials.** The container emits a diff, an mp4 and logs. Every commit, push, PR, Linear issue and Slack message is performed Worker-side.
3. **Policy lives in the bindings.** Channel posting mode and the Linear team id are enforced by the API surface the model calls, not by the prompt. The agent is structurally unable to post to a reference customer channel.
4. **Per-engineer tokens are encrypted at rest** in D1 (AES-GCM, key in a Worker secret) and never exposed to any surface the model reaches.
5. **Secrets never enter the repo.** `.dev.vars` locally, `wrangler secret put` in production. `.gitignore` covers `.dev.vars*` and `.wrangler` — `.env*` alone does not cover the file Wrangler actually reads.
