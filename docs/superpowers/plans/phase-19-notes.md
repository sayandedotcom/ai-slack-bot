# Phase 19 — notes for the AI-tools write-up

Working notes, same contract as the other `phase-*-notes.md` files: what was
verified vs assumed, what the tools invented, what a rebuild needs to know.

## Pre-implementation verification — 2026-08-15, before amending the plan

The plan was re-checked against the tree and against the **exact deployed
image** before implementation started. `firefighter-sandbox:83388698` (local
image ID `4b86fad99569`) is byte-identical to the registry digest `6803aab7…`
that the live app runs, so every fact below is measured on the deployed bits,
not on a lookalike rebuild.

### The live machine cannot be inspected today — three dead ends, recorded so nobody retries them

1. **`wrangler containers ssh` is broken platform-side.** The API call
   succeeds (`POST …/containers/instances/<id>/ssh` → 200 with
   `wss://ssh.containers.cloudflare.com`), then the SSH gateway refuses the
   websocket upgrade with a 400. Same failure on wrangler 4.120.1 and 4.123.0,
   with `wrangler_ssh.enabled: true` live on the app (config version 3, the
   running instance's version). Nothing on our side to fix.
2. **The observability MCP tool cannot parse container/DO events.** The events
   exist (a needle search matches), but rows without `$workers.outcome` fail
   the client's schema validation. Direct API access fails differently: the
   wrangler OAuth token lacks the telemetry-query scope (`code 10000`).
3. **Boot polls leave no trace in D1.** `sandbox.boot` results are not
   effect-keyed, so the provisioning notes (`browser` / `browser-cached` /
   `browser-unavailable` fall through `STEP_NOTES` as raw step names) live only
   in the Run DO's storage, behind Access.

Consequence: whether the *live* machines' Chromium install succeeded has never
been observed. `state: "ready"` does not imply a browser — the step is
deliberately non-fatal. The amended plan makes confirming it the first live
act, and Task 4 gives `record` a named refusal for the browserless case.

### Measured in the deployed image

- **Ground truth:** Node 22.23.2, pnpm 11.17.0, git 2.34.1, no system ffmpeg,
  no `/root/.cache/ms-playwright`, `NODE_PATH=/usr/local/lib/node_modules`,
  globals: `@infisical corepack npm pnpm`.
- **The provision browser step works verbatim** in this image: Chromium
  145.0.7632.6 → `chromium-1208`, headless shell, `ffmpeg-1011`. 385 s total on
  a domestic uplink, of which 314 s was `apt-get update` alone — the number
  says nothing about Cloudflare's network except that the step is correct.
  Downloads now come from `cdn.playwright.dev`, not azureedge.
- **Bundled ffmpeg, corrected count:** **10 encoders** (the plan said 5 — the
  earlier count was from a different probe; wrong number, same conclusion),
  **no h264 encoder, no mp4 muxer**. The transcode finding stands.
- **apt ffmpeg 4.4.2 with `--no-install-recommends`: `libx264` (+`libx264rgb`)
  and the `mp4` muxer are both present.** Asserted by name, 30 s install. Task
  1's premise holds without pulling recommends.
- **`import 'playwright'` from ESM does NOT resolve.** `NODE_PATH` is honored
  only by CJS `require()`; an `.mjs` harness dies with `ERR_MODULE_NOT_FOUND`.
  The recording harness is therefore **`record.cjs`**, not `.mjs`. Found by the
  smoke test failing, not by reading docs.

### The recording-URL decision, grounded

- The Phase 09 artifact pipeline cannot serve recordings, four independent
  ways: no `video/mp4` in the allowlist, 5 MB cap enforced on write *and*
  read, deliberately inert responses (`attachment` + `sandbox` CSP — never
  plays), and the `/api` mount sits behind Cloudflare Access (root 302s to the
  Access login).
- A public bucket domain (r2.dev or custom) is **ruled out hard**: the same
  bucket holds `_internal/` diffs of the private monorepo, and a bucket-wide
  public domain serves everything it can name.
- The Access application already path-bypasses `/slack/events` (probed live:
  it reaches the Worker unauthenticated while `/` 302s). A bypass for a
  dedicated recordings path is therefore an established pattern in this
  deployment, not new machinery — one manual Access-policy addition.

### Binary container→Worker reads: decided, not open

`readFile(path, { encoding: 'none' })` in `@cloudflare/sandbox` 0.12.5 returns
`ReadFileStreamResult` with `content: ReadableStream<Uint8Array>` — raw bytes
over capnp, no base64, no buffering. **RPC-transport only; HTTP/WebSocket
throw** — and both our `getSandbox` call sites already pass
`{ transport: "rpc" }`. The stream feeds `R2Bucket.put` directly, so there is
no Worker-memory ceiling to fight. One live confirmation remains (RPC-only
APIs are the same family as the `tunnels.*` trap): first use asserts it works
across the DO hop.

### Process notes

- The first smoke-test container ran with `--rm` and evaporated on failure,
  taking ~10 minutes of provisioned state with it. Keep verification
  containers un-`--rm`'d until the transcript is saved.
- Host disk was back at 99 % before the check. `docker builder prune` freed
  3.4 GB; deleting superseded image *tags* freed ~0 (shared layers — the
  phase 18 lesson, reconfirmed).
