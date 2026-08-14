# Phase 19 — Ship loop + proof capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent reproduces a bug in a real browser on its own machine, fixes it, re-verifies, and comes away with a playable recording at a public URL — the proof that goes in both the PR body and the customer's thread.

**Architecture:** One new Code Mode namespace, `browser`, with one real method. The model writes a Playwright script as a string; the Worker writes it into the container, runs it inside a harness that owns `recordVideo`, transcodes the result, and streams it to R2, returning a URL. The model never handles bytes, never manages a browser context, and never sees a credential — the same shape as `diff()` returning a ref rather than a patch.

**Tech Stack:** Playwright 1.58 (baked), ffmpeg (**to be added — see Task 1**), R2, `@cloudflare/sandbox`.

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

1. **Playwright's bundled ffmpeg cannot produce mp4.** `/root/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux` is a stripped build: **5 encoders total**, video limited to `png` and `libvpx` (VP8), and **no mp4/mov muxer**. It is what Playwright uses to write the webm and nothing more. The roadmap's task 3 therefore cannot be done with what is already in the image — a real ffmpeg has to be installed. Checked in the built image on 2026-08-14, not assumed.
2. **Chromium and the headless shell are baked** (`chromium-1208`, `chromium_headless_shell-1208`) and `playwright` is on PATH with `NODE_PATH` set, so a script in the container can `require('playwright')`. Phase 18 paid for this deliberately.
3. **Image rebuilds are now cheap.** The image is toolchain-only and its layers are in the registry, so adding ffmpeg pushes one layer instead of gigabytes. This is why Task 1 is affordable at all — it would not have been under Phase 18's original baked image.

## The two decisions this plan makes

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

**Open, to settle in Task 3:** how bytes cross container→Worker. `readFile` in the Phase 18 gateway returns a string and is text-oriented. Read the installed `.d.ts` for a binary or streaming read before writing anything; if none exists, base64 through `exec` is the fallback and its size ceiling must be measured, not assumed.

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

## File structure

- Create: `apps/worker/src/sandbox/record.ts`, `src/codemode/bindings/browser.ts`, `apps/worker/sandbox/harness/record.mjs` (the in-container Playwright wrapper)
- Create tests: `test/sandbox-record.test.ts`, `test/codemode-browser.test.ts`
- Modify: `apps/worker/sandbox/Dockerfile` (ffmpeg), `src/codemode/registry.ts` (tenth namespace), `src/codemode/gateways.ts` (extend `SandboxGateway`), `src/sandbox/gateway.ts`, generated `.d.ts`
- Extend: `test/codemode-dts.test.ts`, `test/codemode-contracts.test.ts`

## Task order

### Task 1 — ffmpeg in the image

- [ ] **Step 1:** Add `ffmpeg` via apt to the Dockerfile's base stage, beside redis. Record the size delta in `phase-19-notes.md` — it is the one layer this phase adds and the push cost is now measured in one layer, not gigabytes.
- [ ] **Step 2:** Verify **in the built image** that the system ffmpeg has an h264 encoder and an mp4 muxer, which Playwright's bundled build does not. Assert both by name; "ffmpeg exists" is not the property that matters.
- [ ] **Step 3:** Rebuild and push. Commit: `feat(sandbox): ffmpeg in the image, because Playwright's bundled build cannot mux mp4`

### Task 2 — The in-container harness

**Files:** create `apps/worker/sandbox/harness/record.mjs`.

- [ ] **Step 1:** A Node script that takes a script path and an output directory, launches Chromium with `recordVideo`, evaluates the model's source with `page` in scope, closes the context so the video flushes (**Playwright only finalises the file on `context.close()`** — a harness that exits first produces a zero-byte video), transcodes webm→mp4 with the system ffmpeg, and prints one parseable result line.
- [ ] **Step 2:** Failure is a result, not a crash: a thrown script yields `state=failed` with the message AND still keeps the video.
- [ ] **Step 3:** Bound it — wall-clock timeout, and refuse a video over the ceiling.
- [ ] **Step 4:** Commit: `feat(sandbox): Playwright recording harness with mp4 transcode`

### Task 3 — Worker-side capture and publish

**Files:** create `src/sandbox/record.ts`, `test/sandbox-record.test.ts`.

- [ ] **Step 1: Read the installed `.d.ts`** for a binary/streaming container read before writing anything (see the open question above). Record what exists in `phase-19-notes.md`.
- [ ] **Step 2: Failing tests** over a stubbed gateway: a passing run publishes and returns a URL; a failing run publishes the video AND surfaces the error; an over-ceiling video is refused readably; dev-env values are redacted from `stdoutTail` and `error`; the R2 key is NOT under `_internal/`.
- [ ] **Step 3:** Implement, reusing Phase 09's publisher for the R2 write.
- [ ] **Step 4:** Commit: `feat(sandbox): capture recordings Worker-side and publish to R2`

### Task 4 — The `browser` namespace

**Files:** create `src/codemode/bindings/browser.ts`, `test/codemode-browser.test.ts`; extend the registry, gateways, and generated `.d.ts`.

- [ ] **Step 1: Failing tests.** Both methods classified `sandbox_write`; appended to `PHASE_09_NAMESPACES` at the END; a call before `boot` refused with the poll-again code; `timeoutMs` over the ceiling refused not clamped; method names globally unique after PascalCase derivation.
- [ ] **Step 2:** Implement. `.d.ts` prose is prompt engineering: say that `page` is in scope, that throwing is how you fail, that a failing repro is a useful result worth keeping, and that the URL is safe to put in a PR body and a Slack message.
- [ ] **Step 3:** Regenerate declarations, verify `codemode:dts:check` clean.
- [ ] **Step 4:** Commit: `feat(codemode): the browser namespace — record, and keep the proof`

### Task 5 — Live proof

- [ ] **Step 1:** Plant a reproducible bug on a branch of the monorepo.
- [ ] **Step 2:** From a real run: boot, start the dev server, write a Playwright script that reproduces it, record the failure, apply a fix, re-record the pass.
- [ ] **Step 3:** Confirm both recordings play from their R2 URLs in a browser and render in a Slack message.
- [ ] **Step 4:** Record timings and every invented API in `phase-19-notes.md`. Commit: `docs(sandbox): record phase 19 live verification`

## Exit criteria

A planted bug is reproduced on a cloud machine, fixed, re-verified, and a playable mp4 sits at an R2 URL — with the failing recording kept too, because that is the artifact that proves the bug was real.

## Downstream handoff

**Phase 20** consumes `RecordingStatus.url` for the PR body and the Slack reply. It needs no new plumbing: the URL is a plain string.
