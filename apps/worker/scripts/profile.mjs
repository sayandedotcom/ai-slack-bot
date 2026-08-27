#!/usr/bin/env node
/**
 * Deployment profiles: move every tenant-varying value at once.
 *
 * WHY THIS EXISTS. Switching this Worker from one org's Slack/GitHub/Linear/
 * Supabase to another means moving 35 values that live in three unrelated
 * places: `.dev.vars` (local), the `vars` block of `wrangler.jsonc`
 * (committed), and Cloudflare's secret store (remote). Nothing checks that the
 * three agree, so a half-finished switch looks exactly like a finished one
 * until something misbehaves in production.
 *
 * THE FAILURE THIS PREVENTS. `SLACK_APP_ID` and `SLACK_BOT_USER_ID` are the
 * loop guard (`src/ingest/rules.ts`): they are how ingest recognises this
 * app's own user-token posts and keeps them out of triage. Point the Worker at
 * a new Slack app and forget those two, and every message the agent sends is
 * re-ingested as customer input and routed back into its own run — the agent
 * answers itself, forever, spending real money. It is invisible in review and
 * only shows up live. So `apply` refuses to push a profile whose
 * `SLACK_BOT_USER_ID` does not match what `auth.test` reports for that
 * profile's own bot token.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *
 *  - D1, R2, queue and Durable Object bindings. Swapping those swaps DATA, and
 *    that must never be one command away from a typo.
 *  - `src/access/roster.ts`. Who may approve is code, reviewed as code.
 *  - Deployment. `apply` prepares; a human runs `pnpm run deploy`. Patched vars
 *    only take effect on the next deploy, and that ordering should be visible.
 *
 * Usage:
 *   node scripts/profile.mjs list
 *   node scripts/profile.mjs show <name>
 *   node scripts/profile.mjs capture <name>      # snapshot what is live NOW
 *   node scripts/profile.mjs verify [<name>]     # current .dev.vars if omitted
 *   node scripts/profile.mjs apply <name> [--local-only] [--skip-verify]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = join(WORKER_ROOT, "config", "profiles");
const DEV_VARS = join(WORKER_ROOT, ".dev.vars");
const WRANGLER = join(WORKER_ROOT, "wrangler.jsonc");

/**
 * The vars that belong to a tenant, and therefore move with a profile.
 *
 * Everything else in the `vars` block is universal — `NUDGE_MODE`,
 * `SANDBOX_GIT_HOST`, `SANDBOX_SLEEP_AFTER`, `LANGSMITH_ENDPOINT`,
 * `RUN_SPEND_CEILING_NANO_USD`, `BETTERSTACK_SQL_ENDPOINT` — and is left alone
 * on purpose: a profile that carried them would invite one tenant's tuning to
 * silently become another's.
 */
const TENANT_VARS = [
  "SLACK_APP_ID",
  "SLACK_BOT_USER_ID",
  "NUDGE_FALLBACK_CHANNEL_ID",
  "GITHUB_REPO",
  "GITHUB_BASE",
  "GITHUB_AUTHOR",
  "SANDBOX_REPO_PATH",
  "LINEAR_TEAM_ID",
  "LINEAR_TEAM_NAME",
  "SUPABASE_URL",
  "LANGSMITH_WORKSPACE_ID",
  "LANGSMITH_PROJECT_ID",
  "LANGSMITH_PROJECT_NAME",
  "BETTERSTACK_LOG_SOURCE_IDS",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_APP_AUD",
  "DASHBOARD_BASE_URL",
  "ARTIFACTS_BASE_URL",
  "PROOFS_BASE_URL",
];

// ---------------------------------------------------------------- reading

/** Parse `.dev.vars`. Blank lines and `#` comments are skipped; values are raw. */
function readDevVars(path = DEV_VARS) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Read one var's value out of `wrangler.jsonc`.
 *
 * Text, not JSON.parse: the file is JSONC and carries the comments that explain
 * every pin. Those comments are the documentation for this whole config, so the
 * file is never round-tripped through a parser that would drop them.
 */
function readWranglerVar(source, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(source);
  return m ? JSON.parse(m[1]) : null;
}

/** Replace one var's value in place, preserving every comment around it. */
function patchWranglerVar(source, key, value) {
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (!re.test(source)) return { source, patched: false };
  return {
    source: source.replace(re, `$1${JSON.stringify(value)}`),
    patched: true,
  };
}

function profilePath(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    fail(`profile name must be kebab-case: got ${JSON.stringify(name)}`);
  }
  return join(PROFILE_DIR, `${name}.json`);
}

function loadProfile(name) {
  const path = profilePath(name);
  if (!existsSync(path))
    fail(`no such profile: ${name}\nrun: pnpm run profile list`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed.secrets || !parsed.vars)
    fail(`${name}.json needs both "secrets" and "vars"`);
  return parsed;
}

function fail(message) {
  console.error(`\nprofile: ${message}\n`);
  process.exit(1);
}

/** Names only, never values — this output is meant to be safe to paste. */
function shape(value) {
  if (typeof value !== "string" || value === "") return "(empty)";
  return `${value.length} chars`;
}

// ---------------------------------------------------------------- verify

/**
 * Confirm a profile's Slack pins actually belong to its bot token.
 *
 * `auth.test` reports the bot's user id, which is half the loop guard. The
 * other half, `SLACK_APP_ID`, has NO API that returns it for a bot token —
 * `bots.info` would, but it needs `users:read`, a scope this app deliberately
 * does not hold. So the app id is shape-checked only, and the caller is told
 * plainly that it was not proven. Saying "verified" about something unchecked
 * would be worse than saying nothing.
 */
async function verifySlack(secrets, vars) {
  const token = secrets.SLACK_BOT_TOKEN;
  if (!token) return [{ level: "error", text: "SLACK_BOT_TOKEN is missing" }];

  let body;
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${token}` },
    });
    body = await res.json();
  } catch (err) {
    return [{ level: "error", text: `auth.test failed: ${String(err)}` }];
  }
  if (!body.ok)
    return [{ level: "error", text: `auth.test refused: ${body.error}` }];

  const notes = [
    {
      level: "ok",
      text: `Slack token valid — workspace ${body.team} (${body.team_id})`,
    },
  ];

  if (vars.SLACK_BOT_USER_ID !== body.user_id) {
    notes.push({
      level: "error",
      // The whole reason this tool exists. Spell out the consequence.
      text:
        `SLACK_BOT_USER_ID is ${vars.SLACK_BOT_USER_ID || "(unset)"} but this token's bot is ` +
        `${body.user_id}. THIS IS THE LOOP GUARD: with it wrong, the agent re-ingests its own ` +
        `replies as customer messages and answers itself.`,
    });
  } else {
    notes.push({
      level: "ok",
      text: `SLACK_BOT_USER_ID matches the token (${body.user_id})`,
    });
  }

  if (!/^A[A-Z0-9]{8,}$/.test(vars.SLACK_APP_ID ?? "")) {
    notes.push({
      level: "error",
      text: `SLACK_APP_ID is not an app id: ${vars.SLACK_APP_ID}`,
    });
  } else {
    notes.push({
      level: "warn",
      text: `SLACK_APP_ID ${vars.SLACK_APP_ID} is well-formed but UNVERIFIED — no API returns it for a bot token. Confirm it on the app's Basic Information page.`,
    });
  }
  return notes;
}

/**
 * Confirm the AI Gateway credentials without spending a token.
 *
 * A deliberately empty body separates the two failures cleanly: gateway auth is
 * checked before the request is forwarded, so a bad `cf-aig-authorization`
 * answers 401, while a good one gets far enough for Anthropic to reject the
 * body with 400. Either way no model runs and nothing is billed.
 */
async function verifyGateway(secrets) {
  const url = secrets.AI_GATEWAY_ANTHROPIC_URL;
  const token = secrets.AI_GATEWAY_TOKEN;
  if (!url || !token) {
    return [
      {
        level: "warn",
        text: "AI_GATEWAY_* not set — no turn can call the model",
      },
    ];
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "cf-aig-authorization": `Bearer ${token}`,
        "x-api-key": secrets.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (res.status === 401) {
      return [
        {
          level: "error",
          text: "AI_GATEWAY_TOKEN rejected (401) — needs the 'AI Gateway - Run' permission",
        },
      ];
    }
    return [
      {
        level: "ok",
        text: `AI Gateway reachable and authorised (HTTP ${res.status} from the provider)`,
      },
    ];
  } catch (err) {
    return [{ level: "warn", text: `AI Gateway probe failed: ${String(err)}` }];
  }
}

/** Flag secrets one profile has and another lacks — the classic half-switch. */
function comparePeers(name, secrets) {
  const notes = [];
  for (const file of listProfiles()) {
    if (file === name) continue;
    let peer;
    try {
      peer = JSON.parse(readFileSync(profilePath(file), "utf8"));
    } catch {
      continue;
    }
    const missing = Object.keys(peer.secrets ?? {}).filter(
      (k) => !(k in secrets)
    );
    if (missing.length > 0) {
      notes.push({
        level: "warn",
        text: `missing vs "${file}": ${missing.join(", ")}`,
      });
    }
  }
  return notes;
}

function report(notes) {
  const icon = { ok: "  ok  ", warn: " warn ", error: " FAIL " };
  for (const n of notes) console.log(`[${icon[n.level]}] ${n.text}`);
  return notes.some((n) => n.level === "error");
}

// ---------------------------------------------------------------- commands

function listProfiles() {
  if (!existsSync(PROFILE_DIR)) return [];
  return readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

function cmdList() {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log("no profiles yet — run: pnpm run profile capture <name>");
    return;
  }
  for (const name of profiles) {
    const p = JSON.parse(readFileSync(profilePath(name), "utf8"));
    const repo = p.vars?.GITHUB_REPO ?? "?";
    const app = p.vars?.SLACK_APP_ID ?? "?";
    console.log(`${name.padEnd(16)} slack=${app.padEnd(12)} repo=${repo}`);
  }
}

function cmdShow(name) {
  const p = loadProfile(name);
  console.log(`profile: ${name}\n\nvars (values are not secret):`);
  for (const [k, v] of Object.entries(p.vars))
    console.log(`  ${k.padEnd(28)} ${v}`);
  console.log("\nsecrets (names and sizes only):");
  for (const k of Object.keys(p.secrets).sort())
    console.log(`  ${k.padEnd(28)} ${shape(p.secrets[k])}`);
}

function cmdCapture(name) {
  const secrets = readDevVars();
  if (Object.keys(secrets).length === 0)
    fail(`.dev.vars is empty or missing — nothing to capture`);

  const source = readFileSync(WRANGLER, "utf8");
  const vars = {};
  const absent = [];
  for (const key of TENANT_VARS) {
    const value = readWranglerVar(source, key);
    if (value === null) absent.push(key);
    else vars[key] = value;
  }

  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    profilePath(name),
    `${JSON.stringify({ name, capturedAt: new Date().toISOString(), vars, secrets }, null, 2)}\n`,
    { mode: 0o600 }
  );

  console.log(
    `captured ${Object.keys(secrets).length} secrets and ${Object.keys(vars).length} vars`
  );
  console.log(`wrote ${profilePath(name)} (0600)`);
  if (absent.length > 0)
    console.log(`not present in wrangler.jsonc: ${absent.join(", ")}`);
}

async function cmdVerify(name) {
  const { secrets, vars } = name
    ? loadProfile(name)
    : {
        secrets: readDevVars(),
        vars: Object.fromEntries(
          TENANT_VARS.map((k) => [
            k,
            readWranglerVar(readFileSync(WRANGLER, "utf8"), k),
          ]).filter(([, v]) => v !== null)
        ),
      };

  console.log(
    `verifying ${name ?? "the current .dev.vars + wrangler.jsonc"}\n`
  );
  const notes = [
    ...(await verifySlack(secrets, vars)),
    ...(await verifyGateway(secrets)),
    ...(name ? comparePeers(name, secrets) : []),
  ];
  if (report(notes)) fail("verification failed — nothing was changed");
  console.log("\nverified.");
}

async function cmdApply(name, opts) {
  const profile = loadProfile(name);

  if (!opts.skipVerify) {
    const notes = [
      ...(await verifySlack(profile.secrets, profile.vars)),
      ...(await verifyGateway(profile.secrets)),
    ];
    if (report(notes))
      fail(
        "refusing to apply a profile that does not verify (--skip-verify overrides)"
      );
    console.log("");
  }

  // 1. Local secrets.
  const lines = Object.entries(profile.secrets).map(([k, v]) => `${k}=${v}`);
  writeFileSync(DEV_VARS, `${lines.join("\n\n")}\n`, { mode: 0o600 });
  console.log(`wrote .dev.vars (${lines.length} secrets, 0600)`);

  // 2. Committed vars. Patched in place so the diff is the record of the switch.
  let source = readFileSync(WRANGLER, "utf8");
  const missed = [];
  let patchedCount = 0;
  for (const [key, value] of Object.entries(profile.vars)) {
    const result = patchWranglerVar(source, key, value);
    source = result.source;
    if (result.patched) patchedCount++;
    else missed.push(key);
  }
  writeFileSync(WRANGLER, source);
  console.log(`patched ${patchedCount} vars in wrangler.jsonc`);
  if (missed.length > 0)
    console.log(`  NOT FOUND (add them by hand): ${missed.join(", ")}`);

  if (opts.localOnly) {
    console.log("\n--local-only: remote secrets untouched.");
    return;
  }

  // 3. Remote secrets, in ONE bulk call. `wrangler secret put` is banned here:
  // from a non-interactive shell it uploads an empty string and reports success.
  const tmp = join(WORKER_ROOT, `.profile-secrets.${process.pid}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(profile.secrets), { mode: 0o600 });
    execFileSync("npx", ["wrangler", "secret", "bulk", tmp], {
      cwd: WORKER_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        CF_API_TOKEN: undefined,
        CLOUDFLARE_API_TOKEN: undefined,
      },
    });
  } finally {
    rmSync(tmp, { force: true });
  }

  console.log(`\napplied "${name}".`);
  console.log(
    "Secrets are live now. Patched vars need a deploy:  pnpm run deploy"
  );
}

// ---------------------------------------------------------------- entry

const [command, arg, ...rest] = process.argv.slice(2);
const opts = {
  localOnly: rest.includes("--local-only") || arg === "--local-only",
  skipVerify: rest.includes("--skip-verify") || arg === "--skip-verify",
};

switch (command) {
  case "list":
    cmdList();
    break;
  case "show":
    if (!arg) fail("usage: profile show <name>");
    cmdShow(arg);
    break;
  case "capture":
    if (!arg) fail("usage: profile capture <name>");
    cmdCapture(arg);
    break;
  case "verify":
    await cmdVerify(arg && !arg.startsWith("--") ? arg : undefined);
    break;
  case "apply":
    if (!arg || arg.startsWith("--"))
      fail("usage: profile apply <name> [--local-only] [--skip-verify]");
    await cmdApply(arg, opts);
    break;
  default:
    console.log(
      [
        "deployment profiles — move every tenant-varying value at once",
        "",
        "  pnpm run profile list                 profiles on this machine",
        "  pnpm run profile show <name>          vars, and secret NAMES only",
        "  pnpm run profile capture <name>       snapshot what is live right now",
        "  pnpm run profile verify [<name>]      check the loop guard and the gateway",
        "  pnpm run profile apply <name>         .dev.vars + wrangler.jsonc + remote secrets",
        "",
        "    --local-only   leave Cloudflare's secret store alone",
        "    --skip-verify  apply even if the checks fail (you had better be sure)",
        "",
        "Profiles live in config/profiles/ and are gitignored: they hold real",
        "credentials. Capture BEFORE you switch, or the setup you are leaving is gone.",
      ].join("\n")
    );
}
