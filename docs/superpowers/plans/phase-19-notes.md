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

### The ffmpeg layer, measured (Task 1)

Image with ffmpeg + the harness: **1.45 GB**, against 871 MB for the deployed
phase-18 image — a **~579 MB delta**, all of it apt's ffmpeg and its transitive
libs (the harness itself is 10 kB). Larger than the 449 MB the in-container
probe suggested, because the image pays for the `.deb` metadata and a handful of
recommends the probe's container already had.

Asserted **in the built image**, not in a probe container: `ffmpeg -encoders`
names `libx264` (and `libx264rgb`), `ffmpeg -muxers` names `mp4`, and
`/usr/local/bin/record-harness.cjs` is present. That is the property Task 1
Step 2 asks for — "ffmpeg exists" would not have been.

Worth knowing for the push: this is one new layer on top of layers the registry
already holds, so the phase-18 economics survive — but 579 MB is not free on a
domestic uplink, and it is the one unavoidable transfer of this phase.

### The harness, proven in the rebuilt image (not stubbed)

The unit tests exercise the Worker side against a stubbed container. Before
spending a live boot, the real `record-harness.cjs` was run inside
`firefighter-sandbox:p19` against four cases. All four behaved as designed:

| Case | RESULT |
|---|---|
| passing script | `state: passed`, `bytes: 9693` — **exactly the file's size on disk** — and `ffprobe` reports `codec_name=h264` |
| script throws (`click` on a missing selector) | `state: failed` carrying Playwright's own `TimeoutError` text, **video kept** (3911 B) |
| script calls `process.exit(0)` | **exactly one RESULT line still printed**; the script sees `TypeError: Cannot read properties of undefined (reading 'exit')` |
| script hangs against an 8 s budget | `state: failed`, "script exceeded timeoutMs (8000ms)", settled at 8.6 s, video kept |

A fifth case was run separately, on a container with **no Chromium at all** — the
state a non-fatal boot install failure actually leaves behind, and a path nothing
had ever exercised:

```
RESULT {"state":"browser-unavailable","error":"browser-unavailable: this run's
container never got a working Chromium install (the boot-time install is
non-fatal by design). Do not retry; report it and continue without a
recording.","video":null,"bytes":null,"durationMs":0}
```

That message is the fix for a defect the whole-branch review caught: the
capability's `.d.ts` told the model `checkRecording` "reports that by name
(`browser-unavailable`)", but the Worker mapped the state to `failed` and
forwarded only the message — which did not contain the token. The model would
have hunted for a string that could never arrive. The old message also told it
to "re-provision", which no capability can do. Both halves are fixed, and the
whole table above was re-run after the fix wave with no regression.

The third row is the one worth keeping. A review found that `new Function`
runs the model's source with the true Node globals reachable, so a script
ending in `process.exit(0)` — a common habit in generated code — would kill the
harness before it printed anything, leaving the Worker polling a process that
had silently died. Shadowing the dangerous globals as unbound parameters turns
that into an ordinary script error the model can read and fix. Argued in
review, then confirmed here against the real binary.

Also confirmed: the rebuild after the harness changed touched **only the
trailing COPY layer** — every other layer reported CACHED and the build took
under a second. That is the layer ordering in the Dockerfile doing its job, and
it is why the harness could be edited late without paying for the image twice.


## Live drill — 2026-08-15, `#test-firedrill`

| Run | Message | Outcome | What it taught |
|---|---|---|---|
| `506ef822` | "record a quick browser session showing what the funnel editor's empty state looks like" | triage `wake=1`; status reply in the thread at ~37 s; container `44fbbba9` running on the new image at **`sin22`** 14 s later; then **`note: "clone"` from 12.9 s to 438 s** — seven minutes on a step that took 28 s in the phase-18 proof — and the run died at its step ceiling. Nothing this phase built was reached: no `mkdir`, no `record`, no Chromium. | **A stalled clone was undetectable and unbounded.** The credential was valid (200 on the repo, the branch and the git smart-HTTP endpoint from here) and the sentinel-swap code was byte-identical to the fast run — so the transfer itself stalled, from a different location than the fast one, and git's defaults let a stalled transfer hang forever. Measured from here: the shallow clone is **401 MB**, 94 s on a domestic uplink; 28 s from Delhi means Cloudflare normally moves it at ~14 MB/s. The step ceiling (24 polls × ~14 s) can never close over a 7-minute clone, and it fired before the 10-minute provisioning deadline could name the step. |

Fix (`ef67140`): `GIT_TERMINAL_PROMPT=0` so a 401 can never sit at a prompt; `http.lowSpeedLimit=10240`/`lowSpeedTime=60` so under 10 KB/s for a minute aborts; `timeout 300` per attempt; three attempts; `--progress` so the container log shows movement. A stall is now a named `FAILED clone` in about a minute, retried twice, instead of a silent seven. `STEP_NOTES` gained the clone, retry, set-remote and browser steps, so the note the model reads describes the work rather than echoing a bare step name.

Two things this drill did NOT answer, still open for the next run: whether `mkdir` on the ops handle works against a real container, and whether Chromium launches on Cloudflare's runtime. Both sit downstream of the clone.

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
