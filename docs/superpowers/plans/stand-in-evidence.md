# Stand-in evidence for `supabase.*` and `langsmith.*`

> ## LangSmith: ANSWERED 2026-08-17 — and the seeding below had never worked
>
> Zellify handed over a key for their real workspace,
> `be566aab-b1b1-4542-9532-aeca116117b2`. It holds the live projects this file
> was asking about:
>
> | project | last run (2026-08-17) |
> |---|---|
> | **`zellify-prod`** | 11:05 — live traffic |
> | `zellify-agent-dev` | 10:04 |
> | `zellify-sandbox-staging` | 6 days |
> | `zellify-sandbox`, `langsmith-polly` | stale |
>
> **Nothing is wired to any of them, deliberately.** The read pin is
> `fire-fighter-standin` (`4a42e1fa-…`), seeded in that workspace; the write
> project is `fire-fighter`. Pointing the read capability at `zellify-prod`
> would let the agent surface real customer traffic into a Slack reply — a
> decision to make on purpose, not a config default.
>
> The earlier key reached workspace `d81d9ce6-…` / project `tweakleaf`, which is
> unreachable from the new key. A cross-workspace project id returns HTTP 200
> with zero runs rather than an error, so a key swap without repointing the pin
> fails **silently**.
>
> **The `--project zellify-web2app-standin` seeding below had never succeeded.**
> `langsmith-seed.mjs` emitted `dotted_order` with three fractional digits;
> ingest requires six and rejects the batch with HTTP 400. That — not "Zellify's
> resources are empty" — is why `tweakleaf` shows zero runs and why
> `phase-09-notes.md` records normalization as never having seen a real trace.
> The script printed its own failure every time. Fixed 2026-08-17; the first
> successful seed in this repo's history ran that day.

**Written 2026-08-16.** Both capabilities are built, keyed, and proven against
their live APIs — and both read **nothing**, because the credentials Zellify
handed over point at empty resources:

| | What the handed-over key reaches | Measured |
|---|---|---|
| LangSmith | one workspace, one project `tweakleaf` — last trace 2026-04-08, `shortlived` (14-day) retention | `runs/query` → HTTP 200, 0 runs (2026-08-16) |
| Supabase | project `uahmoigkzsuwhheohitz`, publishable key — no tables in `public` | every table probe → `PGRST205` 404 (2026-08-12, re-verified 2026-08-16) |

This is not fixable from our side. Two moves, do both:

1. **Ask Ronit** (today) which LangSmith project the prod AI traces into, and
   whether that Supabase project is prod / which schema / a read-only key that
   can see it.
2. **Stand-in data in accounts we own**, so the demo doesn't wait. That is what
   this file sets up. **Say "stand-in project, swaps to prod with two values"
   in the demo** — it is a prop, not customer data.

## Supabase (~15 min)

1. https://supabase.com → new project (free tier, any region). Wait for it to provision.
2. SQL Editor → paste `apps/worker/scripts/supabase-seed.sql` → Run. It creates
   `accounts`, `apps`, `builds` (tenant column `customer_slug`, rows for
   `sidehop` and `firedrill`, one failed build each side), enables RLS with
   SELECT-only policies for `anon`, and revokes writes.
3. Project Settings → API keys → copy the **publishable** key (`sb_publishable_…`).
   Not the secret key — RLS is what makes the read read-only, and the secret
   key bypasses RLS.
4. In `apps/worker/.dev.vars`:
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_KEY=<publishable key>
   ```
   `.dev.vars` overrides `wrangler.jsonc` vars for local dev, so nothing
   committed changes.
5. Prove it: `curl -s -H "apikey: $SUPABASE_KEY" "$SUPABASE_URL/rest/v1/builds?customer_slug=eq.firedrill&select=version,status,error"` → the expired-provisioning-profile row.

`PRODUCTION_ALLOWLIST` (`apps/worker/src/supabase/allowlist.ts`) already mirrors
the seed, and `test/codemode-supabase.test.ts` pins that they match. When Ronit
supplies the real project, replace the seed's tables in the allowlist with the
real ones — the test will tell you the moment they drift.

## LangSmith (~10 min)

1. https://smith.langchain.com → sign up / sign in. **US region** — the reader's
   endpoint is pinned to `api.smith.langchain.com`. Settings → API Keys → create
   a personal access token.
2. From `apps/worker`:
   ```
   LANGSMITH_API_KEY=<that key> node scripts/langsmith-seed.mjs --project zellify-web2app-standin
   ```
   It ingests 5 traces (14 runs): two `web2app.generate_app_config`, one
   `support.ai_reply` where the assistant tells the customer their app is live
   while the tool said `in_review` (the "AI did something weird" case), one
   `web2app.extract_site_manifest` that fails on a 30 s tool timeout, one
   `web2app.generate_icon`. Then it polls until they're queryable and prints
   the project id + the `.dev.vars` lines. The key is never printed.
3. Paste the four printed lines into `apps/worker/.dev.vars`.
4. Prove it in the dashboard chat: "search recent traces for support.ai_reply
   and show me the one for sidehop" — the model should call
   `langsmith.searchTraces` then `langsmith.trace`.

Not yet run against a live account (no personal key on this machine on
2026-08-16); the payload shape follows LangSmith's `POST /runs/batch` contract
with `dotted_order` per the SDK. If ingest returns 4xx, the response body is
printed — fix the field it names and re-run; runs get fresh ids each run, so
re-running only adds traces.

## Deploying the stand-in

Only if the demo runs against the deployed dashboard. Change the vars in
`apps/worker/wrangler.jsonc` (`SUPABASE_URL`, `LANGSMITH_PROJECT_ID`,
`LANGSMITH_PROJECT_NAME`, `LANGSMITH_WORKSPACE_ID`) and
`printf '%s' '<value>' | pnpm exec wrangler secret put SUPABASE_KEY` /
`… LANGSMITH_API_KEY`. Two-line diff, revert when Ronit's real values arrive.
Do this **after** the Phase 20 live drill, with the rest of the held deploy.

## Better Stack, for completeness

Built and live, but `BETTERSTACK_LOG_SOURCE_IDS` names only the firefighter
Worker's own log source (`t582255_firefighter_worker_logs`), not Zellify's app.
Ask Ronit for the prod source name; then it's a one-value change in
`wrangler.jsonc`. No stand-in needed — the Worker's own logs are real data.
