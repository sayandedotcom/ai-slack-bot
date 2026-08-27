#!/usr/bin/env node

/*
 * record.selftest.mjs — runs record.cjs against a FAKE playwright and a FAKE
 * ffmpeg, on this machine, without the image.
 *
 *   node sandbox/harness/record.selftest.mjs
 *
 * Not part of `pnpm test`: the vitest pool is workerd and cannot spawn node.
 * Run it by hand after touching record.cjs, before the image is rebuilt —
 * that rebuild is the expensive step, and this is what stops a harness bug
 * from riding along.
 *
 * What it proves:
 *   1. a script whose first navigation commits late gets its blank lead-in cut
 *      (`-ss` = lead-in minus the margin), and RESULT still says passed+video;
 *   2. a script that navigates immediately is NOT cut (no `-ss`);
 *   3. a script that never navigates is NOT cut, and RESULT is still passed.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, "record.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-record-selftest-"));

// A "browser install" the harness's guard accepts.
const cache = path.join(root, "ms-playwright", "chromium-1234", "chrome-linux");
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, "chrome"), "");

// Fake ffmpeg: log argv, produce the output file.
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
const ffmpegLog = path.join(root, "ffmpeg-args.json");
fs.writeFileSync(
  path.join(bin, "ffmpeg"),
  `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(ffmpegLog)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.argv[process.argv.length - 1], Buffer.alloc(4096, 1));
`
);
fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);

// Fake playwright: `page.goto` waits COMMIT_DELAY_MS (from env) then fires a
// main-frame `framenavigated`, and `context.close()` drops a .webm where the
// harness will look for it.
const pw = path.join(root, "node_modules", "playwright");
fs.mkdirSync(pw, { recursive: true });
fs.writeFileSync(
  path.join(pw, "index.js"),
  `'use strict';
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.chromium = {
  async launch() {
    return {
      async newContext(opts) {
        const dir = opts.recordVideo.dir;
        return {
          async newPage() {
            const listeners = {};
            const frame = { url: () => url };
            let url = 'about:blank';
            const page = {
              on(evt, cb) { (listeners[evt] ||= []).push(cb); },
              mainFrame() { return frame; },
              async goto(target) {
                await sleep(Number(process.env.COMMIT_DELAY_MS || 0));
                url = target;
                for (const cb of listeners.framenavigated || []) cb(frame);
              },
            };
            return page;
          },
          async close() { fs.writeFileSync(path.join(dir, 'x.webm'), Buffer.alloc(1024, 2)); },
        };
      },
      async close() {},
    };
  },
};
`
);

async function run(name, script, commitDelayMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const scriptPath = path.join(dir, "script.js");
  fs.writeFileSync(scriptPath, script);
  fs.rmSync(ffmpegLog, { force: true });
  const { stdout } = await execFileAsync(
    "node",
    [HARNESS, scriptPath, dir, "60000"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_PATH: path.join(root, "node_modules"),
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "ms-playwright"),
        COMMIT_DELAY_MS: String(commitDelayMs),
      },
    }
  );
  if (process.env.DEBUG) console.log(stdout);
  const line = stdout
    .split("\n")
    .filter((l) => l.startsWith("RESULT "))
    .pop();
  const result = JSON.parse(line.slice("RESULT ".length));
  const ffmpeg = fs.existsSync(ffmpegLog)
    ? JSON.parse(fs.readFileSync(ffmpegLog, "utf8"))
    : null;
  return { stdout, result, ffmpeg };
}

function seekOf(argv) {
  const i = argv.indexOf("-ss");
  return i === -1 ? null : Number(argv[i + 1]);
}

let failed = 0;
function check(cond, msg) {
  if (cond) console.log("  ok   " + msg);
  else {
    failed++;
    console.log("  FAIL " + msg);
  }
}

// The model script sleeps after goto so the recording is long enough to cut.
// The hold is baked into the source: the harness shadows `process` inside the
// script on purpose (so a stray `process.exit` cannot kill the RESULT line),
// which is exactly why `process.env` is unreachable from in here.
const navigates = (holdMs) => `await page.goto('http://localhost:4100/');
await new Promise((r) => setTimeout(r, ${holdMs}));`;

console.log("1. late commit is trimmed");
{
  const { result, ffmpeg, stdout } = await run("late", navigates(1500), 2000);
  check(
    result.state === "passed" && result.video !== null,
    "RESULT passed with a video"
  );
  const seek = seekOf(ffmpeg);
  check(seek !== null, "-ss present");
  check(
    seek !== null && seek >= 1.5 && seek <= 1.9,
    `-ss is lead-in minus margin (got ${seek})`
  );
  check(
    ffmpeg.indexOf("-ss") < ffmpeg.indexOf("-i"),
    "-ss precedes -i (input seek)"
  );
  check(
    /trimmed \d+ms of blank lead-in/.test(stdout),
    "the trim is narrated on stdout"
  );
}

console.log("2. immediate commit is not trimmed");
{
  const { result, ffmpeg } = await run("fast", navigates(1500), 50);
  check(
    result.state === "passed" && result.video !== null,
    "RESULT passed with a video"
  );
  check(seekOf(ffmpeg) === null, "no -ss");
}

console.log("3. no navigation is not trimmed");
{
  const { result, ffmpeg } = await run(
    "none",
    `await new Promise((r) => setTimeout(r, 1500));`,
    0
  );
  check(
    result.state === "passed" && result.video !== null,
    "RESULT passed with a video"
  );
  check(seekOf(ffmpeg) === null, "no -ss");
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
