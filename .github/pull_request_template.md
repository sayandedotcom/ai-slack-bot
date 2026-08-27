## What changed

<!-- One paragraph. Why, not just what. -->

## Gate

`pnpm check` at the repository root runs all of this, and CI runs the same.
Tick what you actually ran locally.

- [ ] `pnpm run check:text` — no control bytes in tracked source
- [ ] `pnpm run lint` — Biome format + lint
- [ ] `pnpm run typecheck` — tsc is the ONLY type check; vitest strips types
- [ ] `pnpm run capabilities:dts:check` — generated capability `.d.ts` in sync
- [ ] `pnpm run test` — builds `apps/dashboard/dist` first, then the workerd suite

## Review diff sanity

- [ ] Every changed file renders as a **textual** diff. If any shows
      "Binary files … differ", a control byte got in. `.gitattributes` marks
      these extensions `text diff` and `check-text-files.mjs` fails on the
      byte. This has hidden ~19KB of security tests from review before.

## Blast radius — tick anything this touches

- [ ] `apps/worker/wrangler.jsonc` **`vars`** — a var is public and appears in
      the diff. Ran `pnpm cf-typegen` and committed `worker-configuration.d.ts`?
- [ ] `apps/worker/wrangler.jsonc` **`migrations`** — a NEW tag is applied
      **irreversibly** on the next deploy. A `deleted_classes` entry destroys
      Durable Object storage.
- [ ] `apps/worker/wrangler.jsonc` **`containers[0].image`** — must stay a
      `registry.cloudflare.com/…@sha256:` digest. Rebuilt via
      `sandbox/build.sh` and `wrangler containers push`?
- [ ] A **capability** schema — ran `pnpm capabilities:dts` and committed the
      regenerated `.d.ts`?
- [ ] `@cloudflare/sandbox` version — the Dockerfile `FROM` tag must match the
      installed package **exactly**; a skew is a silent protocol mismatch.
- [ ] A **secret** name — secrets go in via `wrangler secret bulk`, never a
      bare `wrangler secret put` from a non-interactive shell (that uploads an
      empty string and reports success).

## Deploy

- [ ] This does **not** need a deploy, **or** I will dispatch the
      `Deploy Worker` workflow deliberately after merge, with no drill in
      flight — the Worker runs a **one-minute cron**.
