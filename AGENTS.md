# Agent instructions

The authoritative guidance for this repository is **[CLAUDE.md](./CLAUDE.md)** —
architecture, the load-bearing invariants, the gate, and the traps that cost
real time. Read it before writing any code. **[README.md](./README.md)** carries
the security model.

This file exists because `AGENTS.md` is the cross-tool convention; it is a
pointer, not a second source of truth. What follows is only the set of things
that are expensive to learn the hard way.

- **The gate is `pnpm check`** at the repository root: control bytes, Biome,
  `tsc --noEmit`, generated declarations, then the suite. CI runs the same on
  every push. Establish the baseline yourself before judging a change — do not
  trust a stated pass count.
- **This is not a Next.js repository.** `apps/worker` is a Cloudflare Worker;
  `apps/dashboard` is a Vite SPA that the Worker serves from its own origin.
  (This file previously said the opposite, inherited from a starter template.)
- **Formatting and linting are Biome, once, at the root.** There is no ESLint
  and no Prettier. `pnpm format` writes; `pnpm lint` checks. Biome does not
  format Markdown at all, so `.md` files are left alone deliberately.
- **Never commit a control byte.** `.gitattributes` and
  `apps/worker/scripts/check-text-files.mjs` exist because it happened four
  times in one phase, and twice hid roughly 19KB of security tests behind
  "Binary files differ". The pre-commit hook now blocks it.
- **Two files are GENERATED — never hand-edit and never reformat them:**
  `apps/worker/src/capabilities/generated/capabilities.d.ts` (regenerate with
  `pnpm capabilities:dts`) and `apps/worker/worker-configuration.d.ts`
  (`pnpm cf-typegen`). The first is compared BYTE-WISE by
  `pnpm capabilities:dts:check`, so formatting it once breaks that gate
  permanently. Both are excluded from Biome for this reason.
- **Deploying is deliberate.** The `Deploy Worker` workflow is
  `workflow_dispatch` only, behind an environment with required reviewers. The
  Worker runs a one-minute cron, so a deploy swaps it under anything in
  flight. Never add a push trigger.
- **Secrets never enter prompts, events, tool output, logs or memory.** Vars in
  `wrangler.jsonc` are non-secret pins kept in the repository on purpose;
  anything credential-shaped is a `wrangler secret`.
