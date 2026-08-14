#!/usr/bin/env node
'use strict';

/*
 * record.cjs — the in-container Playwright recording harness.
 *
 * Invocation (pinned, do not change without updating the Worker caller):
 *   node /usr/local/bin/record-harness.cjs <scriptPath> <outDir> <timeoutMs>
 *
 * CJS, not ESM. The Dockerfile sets NODE_PATH=/usr/local/lib/node_modules so
 * `require('playwright')` resolves the globally-installed package — the only
 * copy on the machine, since Chromium+Playwright are deliberately not baked
 * into the image (see the Dockerfile). NODE_PATH is honoured only by
 * CommonJS `require()`; an `.mjs` version of this file dies with
 * ERR_MODULE_NOT_FOUND. Measured against the deployed image, not assumed —
 * see docs/superpowers/plans/phase-19-notes.md.
 *
 * The contract with the Worker caller: on exit this prints EXACTLY ONE line
 * starting with "RESULT " to stdout, then exits 0. The LINE is the protocol,
 * not the exit code — a failing model script, a timeout, an oversize video
 * or a browserless machine are all reported as a RESULT, never a crash. The
 * only way this process itself should exit nonzero is a bug in the harness,
 * and even that is caught below and turned into a RESULT line first.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Mirrors the Worker's PROOFS_BASE_URL cap (wrangler.jsonc / Task 3). Kept as
// a separate literal here rather than imported: this file runs inside the
// container, isolated from the Worker's source tree.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const PLAYWRIGHT_CACHE = '/root/.cache/ms-playwright';

function emit(result) {
  process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
  process.exitCode = 0;
  // Setting exitCode (not calling process.exit()) lets Node flush stdout
  // naturally instead of risking truncation: process.exit() right after a
  // write to a non-TTY pipe can cut the write off before it drains. The
  // unref'd fallback below only fires if something (a leaked Playwright or
  // ffmpeg handle) is keeping the event loop alive past a natural exit; by
  // then the RESULT line — a few hundred bytes — has had ample time to flush.
  setTimeout(() => process.exit(0), 2000).unref();
}

// Shared cap for every string that lands in the RESULT line's `error` field
// — the harness spec's "~2000 chars", named once so trimError, the ffmpeg
// stderr tail, and the final (possibly multiply-appended) error all agree
// on the same number.
const ERROR_CHAR_CAP = 2000;

// "constructor name + message, trimmed to ~2000 chars" per the harness spec.
function trimError(err) {
  if (err === undefined || err === null) return 'unknown error';
  const name = (err.constructor && err.constructor.name) || err.name || 'Error';
  const message = err.message !== undefined ? err.message : String(err);
  const full = `${name}: ${message}`;
  return full.length > ERROR_CHAR_CAP ? full.slice(0, ERROR_CHAR_CAP) : full;
}

// Invariant 6: refuse immediately rather than launch-and-crash-opaquely if
// the boot-time Chromium install never completed (it is non-fatal by design
// — see provision.sh — so a "ready" container does not imply a browser).
//
// Mirrors provision.sh's own boot-time guard exactly: glob
// chromium-*/chrome-linux*/chrome under the Playwright cache, not merely a
// non-empty chromium-* directory. An interrupted download leaves a
// non-empty directory with no chrome binary in it — the exact bug
// provision.sh's guard was fixed to stop tripping over — and this harness
// must not disagree with that guard about whether a machine has a browser.
function findChromiumExecutable() {
  let entries;
  try {
    entries = fs.readdirSync(PLAYWRIGHT_CACHE);
  } catch {
    return null;
  }
  for (const entry of entries) {
    // startsWith('chromium-'), not 'chromium_headless_shell-...' — the
    // underscore variant is a different install with a different layout and
    // isn't what provision.sh installs or checks for.
    if (!entry.startsWith('chromium-')) continue;
    const revDir = path.join(PLAYWRIGHT_CACHE, entry);
    let subEntries;
    try {
      subEntries = fs.readdirSync(revDir);
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      if (!sub.startsWith('chrome-linux')) continue;
      const exe = path.join(revDir, sub, 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

async function transcode(webmPath, mp4Path) {
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      webmPath,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      mp4Path,
    ]);
  } catch (err) {
    // execFile's promisified rejection carries .stderr on it; fall back to
    // the trimmed error if for some reason it doesn't.
    const tail = err && typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : trimError(err);
    return { ok: false, error: tail.length > ERROR_CHAR_CAP ? tail.slice(-ERROR_CHAR_CAP) : tail };
  }
  return { ok: true };
}

async function main() {
  const [, , scriptPath, outDir, timeoutMsRaw] = process.argv;
  const timeoutMs = Number(timeoutMsRaw);

  const chromiumExe = findChromiumExecutable();
  if (!chromiumExe) {
    emit({
      state: 'browser-unavailable',
      error: 'the boot-time Chromium install did not complete on this machine; re-provisioning installs it',
      video: null,
      durationMs: 0,
    });
    return;
  }

  const source = fs.readFileSync(scriptPath, 'utf8');
  const videoDir = path.join(outDir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });

  const { chromium } = require('playwright');

  let browser = null;
  let context = null;
  let state = 'passed';
  let error = null;

  // durationMs is wall time from launch to close only — it deliberately
  // excludes the ffmpeg transcode that happens after this block, per the
  // harness contract.
  const launchedAt = Date.now();
  try {
    browser = await chromium.launch();
    context = await browser.newContext({ recordVideo: { dir: videoDir } });
    const page = await context.newPage();

    // The model's script source, wrapped as an async function body with
    // `page` as its only bound name — the exact shape the controller pinned
    // for the harness/Worker contract. `new Function` doesn't close over
    // this file's lexical scope, so `browser`/`context`/`state` etc. are
    // already unreachable — but it still runs against the TRUE Node
    // globals, and model-written Playwright scripts routinely end with a
    // defensive `process.exit(0)`. That call would kill this process before
    // `emit()` ever runs, leaving the Worker polling a process that exited
    // silently with no RESULT line — destroying the one thing the whole
    // protocol depends on. Naming the dangerous globals as extra unbound
    // parameters (and invoking with only `page`) shadows them with a local
    // `undefined` instead: a reference inside the script resolves to that,
    // not the real global. This isn't a real sandbox — a script can still
    // reach globals it can enumerate some other way — it only needs to
    // close this one trivial, extremely common route to silently destroying
    // the RESULT line.
    const runScript = new Function(
      'page',
      'process',
      'require',
      'module',
      'exports',
      '__dirname',
      '__filename',
      'return (async () => {\n' + source + '\n})()'
    );

    const scriptPromise = runScript(page);
    // If the timeout below wins the race, scriptPromise is abandoned but
    // still running; closing the browser out from under it (in `finally`)
    // will make it reject. Nobody else observes that rejection, so without
    // this it becomes an unhandled rejection — which crashes the process on
    // Node 22 and would violate "only a harness bug exits nonzero". The real
    // error, if the script itself threw, is still captured by the race below.
    scriptPromise.catch(() => {});

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`script exceeded timeoutMs (${timeoutMs}ms)`)), timeoutMs);
    });
    try {
      await Promise.race([scriptPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    state = 'failed';
    error = trimError(err);
  } finally {
    // Playwright only finalises the video file on context.close() — a
    // harness that exits (or returns) before this runs produces a zero-byte
    // video. This is why the close happens in `finally` unconditionally:
    // a thrown script or a timeout still needs its video flushed, because a
    // failing repro is exactly the artifact worth keeping. Measured: a
    // TimeoutError script still yielded a playable file once closed here.
    try {
      if (context) await context.close();
    } catch (closeErr) {
      // Ruling 8, same reasoning as the ffmpeg/oversize branches below: a
      // close-time IPC error is the harness's own infrastructure trouble,
      // not evidence the model's script failed. Leave `state` alone —
      // it already reflects the script's own outcome from the try/catch
      // above — and only surface this in `error`, appended rather than
      // overwriting whatever the script's own error already said.
      const closeMsg = trimError(closeErr);
      error = error ? `${error}; ${closeMsg}` : closeMsg;
    }
    try {
      if (browser) await browser.close();
    } catch {
      // Best-effort — the video is already flushed by context.close() above,
      // so a failure to close the browser process itself isn't fatal to the
      // result.
    }
  }
  const durationMs = Date.now() - launchedAt;

  // recordVideo names the file itself; find whatever landed in the dir
  // rather than guessing the name.
  let webmPath = null;
  try {
    const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
    if (files.length > 0) webmPath = path.join(videoDir, files[0]);
  } catch {
    // Missing videoDir here would itself be a harness bug; falls through to
    // "no video" below with whatever state/error is already set.
  }

  let video = null;
  if (webmPath) {
    // resolve, not join: the contract promises an ABSOLUTE mp4 path in the
    // RESULT line regardless of whether the Worker passed outDir as
    // relative or absolute.
    const mp4Path = path.resolve(outDir, 'out.mp4');
    const result = await transcode(webmPath, mp4Path);
    if (result.ok) {
      const { size } = fs.statSync(mp4Path);
      if (size > MAX_VIDEO_BYTES) {
        fs.unlinkSync(mp4Path);
        const sizeMsg = `video too large: ${size} bytes exceeds the ${MAX_VIDEO_BYTES} byte ceiling`;
        error = error ? `${error}; ${sizeMsg}` : sizeMsg;
        // state is deliberately UNCHANGED here — the script's own pass/fail
        // verdict stands. Refusing an oversize artifact is a separate
        // concern from whether the run itself succeeded.
      } else {
        video = mp4Path;
      }
    } else {
      error = error ? `${error}; ffmpeg: ${result.error}` : result.error;
      // state is deliberately UNCHANGED here too, same reasoning as the
      // oversize branch above: `state` reports the SCRIPT's outcome, never
      // the harness's own infrastructure trouble. A script that completed
      // without throwing stays "passed" even when the transcode dies —
      // flipping it to "failed" would tell the model a bug reproduced when
      // it did not, which is the one false-finding outcome the agent design
      // forbids. The missing artifact is `video: null` plus this `error`,
      // loud enough that the model knows its proof link is gone and says so
      // rather than claiming a recording it doesn't have.
    }
  } else if (state === 'passed') {
    // Same reasoning: no video landed at all, but the script itself didn't
    // throw, so state stays "passed" — only the artifact is missing.
    error = error || 'script completed but no video was produced';
  }

  // `error` can grow through several appends by now (a close-time error,
  // an ffmpeg stderr tail, an oversize message, or several of those at
  // once) — re-cap it through the same ~2000-char convention as trimError
  // so one pathological message can't blow past the cap the concatenation
  // was supposed to respect.
  if (error && error.length > ERROR_CHAR_CAP) {
    error = error.slice(0, ERROR_CHAR_CAP);
  }

  emit({ state, error, video, durationMs });
}

main().catch((err) => {
  // A bug in the harness itself (not the model's script) still owes the
  // caller a RESULT line rather than an opaque crash.
  emit({
    state: 'failed',
    error: trimError(err),
    video: null,
    durationMs: 0,
  });
});
