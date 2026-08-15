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

| `b77a4119` | reworded request (see below) | triage `wake=1`; status reply; container `7bb3d77f` on the hardened image at **`hkg13`**; the note advanced to *"first clone attempt failed or stalled; retrying"* and the second attempt was still going at 397 s when the step ceiling killed the run. | **The hardening worked exactly as designed — and proved that hardening was not the fix.** A stall now names itself and retries; but from Hong Kong, as from Singapore, the 401 MB transfer does not complete in five minutes. Two locations, two failures; one location, 28 s. Whatever the path does, the clone had to get smaller. |

**Why the clone is 401 MB, measured:** of the 492 MB working tree, `apps/landing/public` is 212 MB, `apps/docs/public` 136 MB, `apps/dashboard/public` 46 MB — marketing and documentation PNGs (single files of 6–12 MB). Every line of source across all twelve apps is under 25 MB. `--filter=blob:none` alone saves nothing with `--depth 1` (the checkout still materialises every blob at HEAD: 402 MB, 105 s). Cone-mode sparse checkout cannot express "a directory's manifest but not its assets" — a listed directory is always recursive; two attempts confirmed it. Non-cone patterns can.

**Fix (`351042a`):** `--filter=blob:none --sparse`, then `/*` minus `/apps/landing/public/` and `/apps/docs/public/`. Excluded blobs are never fetched. Verified with the **image's own git 2.34.1**: **83 MB in 39 s** against 401 MB in 94 s on the same uplink; all 81 workspace manifests present; `build-packages` filters to `./packages/*`; `reset --hard` + `clean` on the sparse tree leave it clean. `apps/dashboard/public` deliberately kept — the agent may serve the dashboard.

| `cfbb2696` | third reworded request | triage `wake=1`; status reply late; **the sparse 83 MB clone stalled from `sin22` too** — note advanced to *"first clone attempt failed or stalled; retrying"* and the retry was still going at 388 s when the step ceiling fired. | **The sentinel proxy path is the wall, not the byte count — and every local measurement was blind to it.** All my clone timings (28 s, 39 s, 83 MB) went container → host uplink → GitHub *directly*. The live boot goes container → `git.firefighter.local` → the Worker's `interceptHttps` → GitHub. Nothing I can run locally exercises that proxy hop, and it cannot carry the monorepo from an APAC colo at any size I could reach. Phase 18's single clean clone-through-sentinel (~28 s) was one lucky colo, treated as a proven mechanism when it was proven exactly once. |

**The fix that finally fits the measurement: bake the repo, fetch the delta.** Three drills established that the bulk must not cross the sentinel. So it doesn't: the sparse tree is baked into the image (`--mount=type=secret` for the PAT, command-scoped `http.extraHeader` so no credential reaches a layer — build.sh greps the assembled filesystem to prove it, and the baked remote is the sentinel placeholder), delivered over Cloudflare's own registry. Boot does only `git fetch --depth 1`, **bounded to 120 s and non-fatal**: if the sentinel stalls, provisioning drops to the baked commit (`STEP fetch-skipped-baked` → `reset --hard origin/staging` on the baked ref) and the run proceeds on code at most a build old. The sentinel is off the critical path. This is the reversal the Dockerfile's own `node_modules` comment always half-claimed ("what stays baked is ... the repository itself") but the code never did — phase 18 removed the repo for image SIZE (a 6 GB image would not push), and a 148 MB sparse tree does not have that problem. Baked image: 1.54 GB, +90 MB over the boot-clone image. Fallback path proven in the built image before pushing: fetch skips, reset lands on the baked ref, tree clean, all 12 app manifests present.

| `1e4070b5` | "screen-record scrolling the dashboard pricing page" | triage `wake=1`; **baked image booted fully in 2m51s at `sin22`** — the exact colo that stalled twice — then the agent grepped the real pricing source, spawned `next dev` (`✓ Ready in 481ms`, the dev-server-serving milestone phase 18 never reached), and warmed `/pricing`, which returned **500**. It spent its generation budget diagnosing the 500 and died at `generation_cost_limit` before recording. | **Two findings, both progress.** (a) **Baking works.** The sentinel is off the critical path; a cold boot from the worst-observed colo completed in under three minutes and the monorepo dev server came up. (b) **The 500 was my sparse exclusion.** `apps/landing/public/` holds not just 212 MB of marketing PNGs but `fonts/` — the woff2 files `layout.tsx` imports via `next/font/local`. Excluding the whole directory made every landing page fail to compile: `Font file not found: Can't resolve '.../public/fonts/aspekta/Aspekta-400.woff2'`. `public/` in a Next app is not all disposable assets. The agent read the stderr correctly and chased the font — a real bug, just one I planted — burning the budget a clean render would have left for recording. |

| `ee0deade` | "record clicking the dashboard create-funnel button on a clean account" | **The fonts-fixed baked image booted fully in 122 s** (clone-from-registry -> install -> build -> Chromium -> `ready`), the non-fatal fetch caught staging up (ready commit `21000658` != baked `450d1297`), and the agent explored the real dashboard source. But it never recorded: it spent its whole budget hunting for a way to log in -- the dashboard is auth-gated and the sandbox has no seeded account, so "on a clean account" is an unbounded rabbit hole. | **The boot path is proven end to end; the blocker is now the target, not the code.** Baking killed the sentinel problem for good, and this is the fastest cold boot measured (122 s vs 171 s -- the fetch delta was small). An auth-gated flow has no bottom in a sandbox with no login: the agent correctly reasons it needs a session and burns steps looking for a dev-login/seed that does not exist. Recording drills must target something that renders WITHOUT auth -- a landing page or a Storybook story -- or the budget dies in the login hunt before `browser.record`. |

| `1eafter`/landing-pricing | "record scrolling the public /pricing page on a fresh load" | **RECORDED. Phase 19's exit criterion met live.** The agent booted the baked image, spawned `next dev` for the landing app (200 this time -- the font fix held), wrote a Playwright script, recorded, transcoded, uploaded, and posted a `/proofs` URL to the thread with an honest caption. The mp4 verified from a logged-out `curl`: **GET 200, `video/mp4`, 822 KB, `inline`+`nosniff`, `accept-ranges: bytes`, a Range request -> 206**, decoded h264 800x450 13.4 s, plays. | **Every novel downstream mechanism worked on its first live exercise, together:** `browser.record`; Chromium launching on Cloudflare's container runtime **with no `--no-sandbox`** (the staged patch was never needed); `mkdir` on the ops handle writing the script (C1 fix, first real call); the harness's `context.close()` flush; webm->h264 mp4 via apt ffmpeg; `readFile(encoding:'none')` streaming bytes to R2 over the RPC transport across the DO hop; and `/proofs/:key` serving it publicly through the Access bypass with the Range support Safari and Slack need (the I6 fix). The recording half of the exit criterion -- a playable mp4 at a public URL, produced by the agent from model-authored Playwright on a cloud machine -- is proven. |

**The lesson that outlives the drill:** sparse-checking a monorepo to save transfer is a trap when you cannot enumerate what each app's build actually reads, and `public/` is the specific trap (fonts live there, not just images). Once baking moved the bulk to the registry, the transfer-size argument for sparseness evaporated — so the whole tree is baked (2.19 GB image, +250 MB, free over the registry) and no app can be broken by a missing asset. Boot `1e4070b5` also produced the first measured full cold boot on the baked image: **provision.sh 171 s** (clone-from-registry → install → build-packages → browser), dev server ready in 481 ms after.

**A second finding from the re-post.** The identical message, posted fresh 25 minutes after the failed run, was triaged `wake=0`: *"a duplicate or continuation of an existing known request that's already being tracked in memory."* Memory carried the agent's own "Will post the video here in a few minutes" from the dead run, so a genuinely new request read as one already in hand. This is the phase-18 swallowed-thread finding widened: a failed run's optimistic reply now suppresses not just its thread but the next same-shaped request too. Same root cause, same fix — triage needs the run's terminal status as a fact (Phase 21 prompt work), and a `failed` run's promises should carry no weight. Recorded here because it cost a drill cycle; worked around by re-posting with different wording.

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

## The right-edge gap, and the clean 1280x720 proof (2026-08-15)

The first successful recording had a grey strip down the right of the frame. Cause: the
harness created the recordVideo context with no `viewport` and no `size`, so Playwright
locked the video canvas from the default 1280x720 viewport (-> 800x450). The model's own
script then set a 1280x800 (16:10) viewport, which does not match 800x450 (16:9), so
Playwright scaled the mismatch in and PADDED the remainder grey.

Fix, in two parts: (1) pin `viewport` AND `recordVideo.size` to the same 1280x720 in the
harness so the page fills the frame with no scaling; (2) tell the model in the .d.ts that
the viewport is fixed and not to call setViewportSize. Part (2) is Worker-side and took
effect immediately -- the very next recording was gap-free even on the old harness image,
because the model then used a 16:9 viewport that matched. Part (1) landed one container
rollout later and made the file natively 1280x720.

Verified at the pixel level (not by eye): the rightmost column of the 1280x720 recording
is 720/720 rows of page content, 0 flat-grey-pad rows, pure white to the edge. GET 200,
Range -> 206, plays logged out.

Three clean recordings now sit at public /proofs URLs: /pricing (the first proof), the
four /use-cases pages (agent honestly recorded a real 404 on the index route first), and
/pricing with a nav hover. The recording pipeline is proven repeatable across routes and
interactions, not a one-off.
