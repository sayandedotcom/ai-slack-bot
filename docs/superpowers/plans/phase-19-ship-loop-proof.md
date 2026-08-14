# Phase 19 — Ship loop + proof capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent reproduces a bug in a real browser on its own machine, fixes it, re-verifies, and comes away with a playable recording at a public URL — the proof that goes in both the PR body and the customer's thread.

**Architecture:** One new Code Mode namespace, `browser`, with one real method. The model writes a Playwright script as a string; the Worker writes it into the container, runs it inside a harness that owns `recordVideo`, transcodes the result, and streams it to R2, returning a URL. The model never handles bytes, never manages a browser context, and never sees a credential — the same shape as `diff()` returning a ref rather than a patch.

**Tech Stack:** Playwright 1.58 (**installed at boot by provision.sh, non-fatally — NOT baked**, see below), ffmpeg (**to be added — see Task 1**), R2, `@cloudflare/sandbox`.

**Spec:** `docs/superpowers/specs/2026-08-10-firefighter-agent-design.md` §6, §11.1. Roadmap: `00-roadmap.md` Phase 19. Predecessor: [phase-18-sandbox-tier-2.md](phase-18-sandbox-tier-2.md), whose notes file carries the platform traps.

## Global Constraints

All of `00-roadmap.md` "Global Constraints" apply. The ones that bite here:

- **The container holds no write credentials.** The recording leaves via the Worker, not by the container uploading anywhere.
- **A Tier 1 execution is 20 s.** A browser run is not. `record` follows Phase 18's rule: start, return a handle, poll. It does **not** block.
- **One generic agent.** There is no "reproduce a bug" capability. There is a way to run a browser and keep the video; deciding to repro-fix-reverify is the model's.
- **Commit after every task.** Conventional prefixes.

## Depends on

Phase 18, merged and live: the `sandbox` namespace, `SandboxGateway`, `lifecycle`, the R2 internal prefix from `diff.ts`, and a container that boots.

## Verified before planning — read these, they change the work

Everything below was measured on 2026-08-15 **inside the exact deployed image** — local tag `83388698` is byte-identical to the registry digest `6803aab7…` the live app runs. Full transcript in [phase-19-notes.md](phase-19-notes.md).

1. **Playwright's bundled ffmpeg cannot produce mp4.** `/root/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux` is a stripped build: **10 encoders total** (an earlier probe said 5 — wrong count, same conclusion), **no h264 encoder, no mp4/mov muxer**. It is what Playwright uses to write the webm and nothing more. A real ffmpeg has to be installed — and apt's `ffmpeg` 4.4.2 with `--no-install-recommends` **does** carry `libx264` and the `mp4` muxer, asserted by name, 30 s install.
2. **Chromium is NOT baked — an earlier draft of this plan said it was, and that was stale.** Phase 18 moved the 1.19 GB Playwright+Chromium layer out of the image (it could not cross a domestic uplink before the registry credential expired); `provision.sh` installs it at boot, **idempotently and non-fatally** — on failure it prints `STEP browser-unavailable` and provisioning still reaches `ready`. Two consequences: `state: "ready"` does not imply a browser, so `record` needs a named refusal for the browserless machine (Task 4); and **no live machine's browser install has ever been observed succeeding** — the step is unobservable from outside today (`wrangler containers ssh` dies at the SSH gateway with a 400; boot notes never reach D1; details in the notes). Confirming it is the live proof's first act (Task 5). The step itself is correct: run verbatim in the deployed image, it lands Chromium 145.0.7632.6 in `chromium-1208` plus the headless shell.
3. **`import 'playwright'` does NOT resolve from ESM.** `NODE_PATH` is honored only by CJS `require()`; an `.mjs` harness dies with `ERR_MODULE_NOT_FOUND`. The harness is therefore **`record.cjs`**. Found by a failing smoke test, not by reading docs.
4. **The whole recording pipeline is proven in the deployed image.** `recordVideo` context → script runs → `context.close()` flushes the webm → apt ffmpeg transcodes to h264 mp4 (`+faststart`, sub-second for a short clip). And the failure path is real: a script that throws (`TimeoutError` on a missing selector) still yields a flushed, playable video once the harness closes the context — failure-as-a-result is not a design hope, it is observed behavior.
5. **Image rebuilds are now cheap.** The image is toolchain-only and its layers are in the registry, so adding ffmpeg pushes one layer instead of gigabytes. This is why Task 1 is affordable at all — it would not have been under Phase 18's original baked image.

## The three decisions this plan makes

### 1. `record` takes a script, not a callback

Spec §6 sketches `browser.record(fn)` with a real closure. That cannot cross the isolate boundary — the model's code runs in a Worker Loader isolate and Playwright runs in a container, with an RPC hop between them. A function is not marshallable across it.

So the model supplies **Playwright source as a string** and the harness supplies the context:

```ts
declare const browser: {
  /** Run a Playwright script with video recording. `page` is in scope; the last
   *  expression's truthiness is not consulted — throw to fail. Returns a handle;
   *  poll `checkRecording` until it settles. */
  record(a: { script: string; label: string; timeoutMs?: number }): Promise<{ recordingId: string }>;
  checkRecording(a: { recordingId: string }): Promise<RecordingStatus>;
};
type RecordingStatus = {
  state: "running" | "passed" | "failed";
  /** Public URL, present once state is terminal AND a video was produced. */
  url: string | null;
  /** Playwright's own error, trimmed. The reason a repro failed IS the finding. */
  error: string | null;
  stdoutTail: string;
  durationMs: number;
};
```

Writing Playwright as source is what the model is genuinely good at, and it keeps recording, transcoding and uploading in the harness where the credentials are.

### 2. The recording never passes through the model, or through the isolate

A 5–50 MB video cannot go through `toSafeJson` (24 000 chars) and should not go through `files.publish` (which takes bytes as a capability argument). The harness reads the file container-side, streams it to R2 Worker-side, and returns a URL — the identical shape to Phase 18's `diffRef`, and for the identical reason.

**Settled (was open):** bytes cross container→Worker as a raw stream. `@cloudflare/sandbox` 0.12.5's `readFile(path, { encoding: 'none' })` returns `content: ReadableStream<Uint8Array>` over capnp — no base64, no SSE framing, no buffering — and feeds `R2Bucket.put` directly, so there is no Worker-memory ceiling to fight. It is **RPC-transport only** (HTTP/WebSocket throw), and both our `getSandbox` call sites already pass `{ transport: "rpc" }`. One caveat carried into Task 3: RPC-only APIs are the same family as the spike's `tunnels.*` trap, so the first live use asserts the stream survives the DO hop rather than assuming it.

### 3. The recording URL is a dedicated Worker route behind an Access **bypass** — not the Phase 09 publisher, not a public bucket

Slack has to fetch the video with no Access token, and a customer clicks the link cold. Neither existing path can serve that:

- **Phase 09's artifacts pipeline refuses video four independent ways, all deliberate:** no `video/mp4` in the allowlist, a 5 MB cap enforced on write *and* read, responses made inert (`attachment` disposition + `sandbox` CSP — never plays in a browser), and the `/api` mount behind Cloudflare Access. `src/api/artifacts.ts` predicted this exact moment in its own comments. Those defenses are correct for artifacts and must not be loosened — recordings get their own route.
- **A public bucket domain (r2.dev or custom) is ruled out hard:** the same bucket holds `_internal/` diffs of the private monorepo, and a bucket-wide public domain serves everything it can name.

So: a new route (`/proofs/:key`), with a **path-bypass policy on the Access application** — the established pattern here, `/slack/events` already bypasses (probed live: it reaches the Worker unauthenticated while `/` 302s to the Access login). The route carries its own defenses because "behind Access" no longer applies to it: key shape validated before any bucket call (unguessable content-hash key + `.mp4` only), `video/mp4` re-derived not read back, `inline` disposition (it must play), `nosniff`, its own byte ceiling, and a positive refusal of the `_internal/` namespace. Public-by-design cache headers are fine — the key is the secret.

**The Access bypass is a manual dashboard step** (one policy on the existing Access app) and it belongs to whoever owns the dashboard — flagged in Task 3 as a hand-off, not silently assumed.

## Outcome

- The model writes a Playwright script, calls `record`, polls, and gets back a URL to a playable mp4.
- A failing repro is a **first-class result**, not an error: `state: "failed"` with Playwright's own message and the video of the failure, which is exactly what proves the bug.
- The verify cycle — repro fails → apply fix → repro passes → keep the passing recording — is something the model composes from these pieces. Nothing in the harness knows what a "bug" is.

## What this phase deliberately does not do

- **No screen-capture rig.** `recordVideo` on the browser context, per the spec.
- **No PR, no Linear, no Slack.** Phase 20 consumes the URL.
- **No assertion DSL.** The script throws or it does not.
- **No parallel browsers.** One recording at a time per run; `standard-4` has 12 GiB and a dev server may already want 6.

## Non-negotiable invariants

1. **No credential in the container**, unchanged from Phase 18. The R2 write is Worker-side.
2. **Dev-env values are redacted** from `stdoutTail` and `error` exactly as Phase 18 redacts `exec` output — a Playwright script that prints `process.env` must not leak through a new door.
3. **A recording is bounded.** A hard ceiling on video bytes, refused with a readable reason rather than truncated into an unplayable file.
4. **`record` never blocks past the execution budget.** Start, handle, poll.
5. **The R2 key for a recording is public-by-design** (it goes in a Slack message), and therefore must NOT use the `_internal/` prefix that `diff.ts` reserved. Recordings are published artifacts; diffs are not.
6. **A browserless machine is a named refusal, not a hang.** The boot-time Chromium install is non-fatal by design, so `record` on a machine where it failed must fail immediately with a message that says what happened (`browser-unavailable`) and what to do — never spawn a harness that dies opaquely.

## File structure

- Create: `apps/worker/src/sandbox/record.ts`, `src/api/proofs.ts` (the bypassed serving route), `src/codemode/bindings/browser.ts`, `apps/worker/sandbox/harness/record.cjs` (the in-container Playwright wrapper — **CJS, because `NODE_PATH` does not reach ESM imports**)
- Create tests: `test/sandbox-record.test.ts`, `test/api-proofs.test.ts`, `test/codemode-browser.test.ts`
- Modify: `apps/worker/sandbox/Dockerfile` (ffmpeg), `apps/worker/sandbox/provision.sh` (browser-cached guard, see Task 1), `src/index.ts` (mount the route), `src/codemode/registry.ts` (tenth namespace), `src/codemode/gateways.ts` (extend `SandboxGateway`), `src/sandbox/gateway.ts`, generated `.d.ts`
- Extend: `test/codemode-dts.test.ts`, `test/codemode-contracts.test.ts`
- Manual, outside the repo: one Access bypass policy for `/proofs/*` (Task 3 flags it before the live proof needs it)

## Task order

### Task 1 — ffmpeg in the image, and an honest browser-cached guard

- [ ] **Step 1:** Add `ffmpeg` via apt to the Dockerfile's base stage, beside redis, with `--no-install-recommends` — already proven sufficient: apt's 4.4.2 carries `libx264` and the `mp4` muxer (asserted by name in the deployed image, 2026-08-15). Record the layer's size delta in `phase-19-notes.md` — it is the one layer this phase adds.
- [ ] **Step 2:** Re-assert in the **built** image that `ffmpeg -encoders` names `libx264` and `-muxers` names `mp4` — cheap, and it pins the property that matters against a future base-image bump. "ffmpeg exists" is not that property.
- [ ] **Step 3:** Fix `provision.sh`'s browser-cached guard: today it declares the browser cached if `/root/.cache/ms-playwright` is merely non-empty, so an interrupted download poisons every later boot into skipping the install. Test for the Chromium executable itself, not the directory.
- [ ] **Step 4:** Rebuild and push. Commit: `feat(sandbox): ffmpeg in the image, because Playwright's bundled build cannot mux mp4`

### Task 2 — The in-container harness

**Files:** create `apps/worker/sandbox/harness/record.cjs`.

**CJS, not ESM** — `NODE_PATH` reaches only `require()`, and the global Playwright install is the only one on the machine; an `.mjs` harness dies with `ERR_MODULE_NOT_FOUND` (measured, see notes). The whole sequence this task builds — `recordVideo` context, model script, `context.close()` flush, apt-ffmpeg transcode, thrown-script-keeps-the-video — already ran green in the deployed image, so this task is packaging proven behavior, not exploring.

- [ ] **Step 1:** A Node script that takes a script path and an output directory, refuses immediately with a `browser-unavailable` result if the Chromium executable is absent (invariant 6), launches Chromium with `recordVideo`, evaluates the model's source with `page` in scope, closes the context so the video flushes (**Playwright only finalises the file on `context.close()`** — a harness that exits first produces a zero-byte video), transcodes webm→mp4 with the system ffmpeg (`libx264`, `yuv420p`, `+faststart` so it streams), and prints one parseable result line.
- [ ] **Step 2:** Failure is a result, not a crash: a thrown script yields `state=failed` with the message AND still keeps the video — the harness's own try/catch closes the context either way (proven: a `TimeoutError` script still produced a playable file).
- [ ] **Step 3:** Bound it — wall-clock timeout, and refuse a video over the ceiling.
- [ ] **Step 4:** Commit: `feat(sandbox): Playwright recording harness with mp4 transcode`

### Task 3 — Worker-side capture, publish, and the serving route

**Files:** create `src/sandbox/record.ts`, `src/api/proofs.ts`, `test/sandbox-record.test.ts`, `test/api-proofs.test.ts`; mount in `src/index.ts`.

The container→Worker read is settled (decision 2): `readFile(path, { encoding: 'none' })` streams raw bytes on the RPC transport and feeds `R2Bucket.put` directly. NOT Phase 09's publisher — its caps, allowlist, inert headers and Access gate all refuse video on purpose (decision 3).

- [ ] **Step 1: Failing tests, capture side,** over a stubbed gateway: a passing run publishes and returns a URL; a failing run publishes the video AND surfaces the error; an over-ceiling video is refused readably; dev-env values are redacted from `stdoutTail` and `error`; the R2 key is NOT under `_internal/` and is content-hash unguessable.
- [ ] **Step 2: Failing tests, serving side** (`/proofs/:key`, GET+HEAD together — the artifacts route's lesson): only the publisher's exact key shape reaches the bucket; `_internal/` refused positively and first; `video/mp4` re-derived from the validated extension; `inline` disposition + `nosniff`; over-ceiling objects refused; one indistinguishable 404 for every failure.
- [ ] **Step 3:** Implement both. The stream from `readFile` goes to R2 without ever materialising in Worker memory.
- [ ] **Step 4:** Tell the user the `/proofs/*` Access bypass policy is needed **now**, before Task 5 — it is one manual policy on the existing Access application, same pattern as `/slack/events`. Until it exists, recording URLs 302 to an Access login for anyone but the team.
- [ ] **Step 5:** Commit: `feat(sandbox): stream recordings to R2 and serve them from a bypassed route`

### Task 4 — The `browser` namespace

**Files:** create `src/codemode/bindings/browser.ts`, `test/codemode-browser.test.ts`; extend the registry, gateways, and generated `.d.ts`.

- [ ] **Step 1: Failing tests.** Both methods classified `sandbox_write`; appended to `PHASE_09_NAMESPACES` at the END; a call before `boot` refused with the poll-again code; a browserless machine surfaced as the harness's named `browser-unavailable` result with an actionable message, not a generic failure; `timeoutMs` over the ceiling refused not clamped; method names globally unique after PascalCase derivation.
- [ ] **Step 2:** Implement. `.d.ts` prose is prompt engineering: say that `page` is in scope, that throwing is how you fail, that a failing repro is a useful result worth keeping, and that the URL is safe to put in a PR body and a Slack message.
- [ ] **Step 3:** Regenerate declarations, verify `codemode:dts:check` clean.
- [ ] **Step 4:** Commit: `feat(codemode): the browser namespace — record, and keep the proof`

### Task 5 — Live proof

- [ ] **Step 1: Confirm the live machine has a browser at all.** No live machine's Chromium install has ever been observed succeeding (the step is non-fatal and unobservable from outside — see "Verified before planning" #2). First act: a trivial `record` against a data-URL page on a live run. If it comes back `browser-unavailable`, fix the boot path before anything else in this task — nothing later is meaningful without it.
- [ ] **Step 2:** Plant a reproducible bug on a branch of the monorepo.
- [ ] **Step 3:** From a real run: boot, start the dev server, write a Playwright script that reproduces it, record the failure, apply a fix, re-record the pass.
- [ ] **Step 4:** Confirm both recordings play from their `/proofs/` URLs **in a logged-out browser session** (the Access bypass is what is under test, not just the route) and render in a Slack message.
- [ ] **Step 5:** Record timings and every invented API in `phase-19-notes.md`. Commit: `docs(sandbox): record phase 19 live verification`

## Exit criteria

A planted bug is reproduced on a cloud machine, fixed, re-verified, and a playable mp4 sits at a `/proofs/` URL that opens logged-out — with the failing recording kept too, because that is the artifact that proves the bug was real.

## Downstream handoff

**Phase 20** consumes `RecordingStatus.url` for the PR body and the Slack reply. It needs no new plumbing: the URL is a plain string.
