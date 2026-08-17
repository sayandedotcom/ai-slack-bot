#!/usr/bin/env node
/**
 * Seed a LangSmith project with a handful of web2app-shaped traces so the
 * firefighter's `langsmith.trace` / `langsmith.searchTraces` capability has
 * something to read.
 *
 * WHY: the key Zellify handed over sees one project (`tweakleaf`) whose last
 * trace was 2026-04-08 on a 14-day retention tier — it is empty and will stay
 * empty until their prod AI traces somewhere. This writes stand-in traces into
 * a project WE own. It is a demo prop; say so.
 *
 * USAGE (from apps/worker):
 *   LANGSMITH_API_KEY=<your-personal-key> node scripts/langsmith-seed.mjs \
 *       --project zellify-web2app-standin [--endpoint https://api.smith.langchain.com] [--dry-run]
 *
 * The key is read from the environment only. It is never printed. Point it at
 * YOUR account (US region — the reader's endpoint is pinned to
 * api.smith.langchain.com), not at Zellify's workspace: writing demo data into
 * someone else's project is not ours to decide.
 *
 * On success it prints the project id and the four lines to paste into
 * `.dev.vars` (which overrides wrangler.jsonc vars for local dev). For the
 * deployed Worker, change the same four vars in wrangler.jsonc.
 *
 * Trace shapes match what the reader expects: root runs carry a searchable
 * name (searchTraces matches on run names), children are llm/tool spans, one
 * trace fails on a tool timeout, and one is the "AI did something weird" case —
 * a success whose output contradicts its tool result.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const DRY = args.includes("--dry-run");
const ENDPOINT = (flag("endpoint", "https://api.smith.langchain.com")).replace(/\/$/, "");
const PROJECT = flag("project", "zellify-web2app-standin");
const KEY = process.env.LANGSMITH_API_KEY;
if (!KEY && !DRY) {
  console.error("LANGSMITH_API_KEY is not set (put it in the environment for this one command; it is not read from .dev.vars on purpose).");
  process.exit(2);
}
const headers = { "x-api-key": KEY ?? "", "content-type": "application/json" };

// LangSmith's dotted_order: compact ISO timestamp + run id, children append
// ".<their own>" to the parent's. This is what orders spans inside a trace.
//
// MICROSECONDS -- six fractional digits, padded from toISOString()'s three.
// Ingest parses this with the Go layout `20060102T150405.000000` and rejects
// anything shorter with HTTP 400:
//
//   invalid 'dotted_order': ... parsing time "20260817T083114.022" as
//   "20060102T150405.000000": cannot parse ".022" as ".000000"
//
// This script emitted the unpadded form until 2026-08-17, so every ingest it
// ever attempted was rejected -- which is why the seeded project has zero runs
// (phase-09-notes.md). The failure was visible in the script's own output and
// nobody read it. Verified fixed by scripts/langsmith-trace-smoke.mts.
const compact = (d) =>
  d.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "000Z");
const uuid = () => crypto.randomUUID();

/** Build one trace: a root plus ordered children. Returns flat run objects. */
function trace({ name, startedAgoMin, customer, inputs, outputs, error, children, metadata = {} }) {
  const traceId = uuid();
  const rootStart = new Date(Date.now() - startedAgoMin * 60_000);
  let cursor = rootStart.getTime();
  const runs = [];
  const rootOrder = `${compact(rootStart)}${traceId}`;
  const childRuns = children.map((c) => {
    const id = uuid();
    const start = new Date(cursor + 50);
    const end = new Date(start.getTime() + c.durationMs);
    cursor = end.getTime();
    return {
      id,
      trace_id: traceId,
      parent_run_id: traceId,
      dotted_order: `${rootOrder}.${compact(start)}${id}`,
      name: c.name,
      run_type: c.runType,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      inputs: c.inputs,
      outputs: c.error ? undefined : c.outputs,
      error: c.error,
      session_name: PROJECT,
      extra: { metadata: { customer_slug: customer, ...metadata } },
    };
  });
  const rootEnd = new Date(cursor + 30);
  runs.push({
    id: traceId,
    trace_id: traceId,
    dotted_order: rootOrder,
    name,
    run_type: "chain",
    start_time: rootStart.toISOString(),
    end_time: rootEnd.toISOString(),
    inputs,
    outputs: error ? undefined : outputs,
    error,
    session_name: PROJECT,
    extra: { metadata: { customer_slug: customer, ...metadata } },
  }, ...childRuns);
  return runs;
}

const llmCall = (name, prompt, completion, ms, extra = {}) => ({
  name,
  runType: "llm",
  durationMs: ms,
  inputs: { messages: [{ role: "user", content: prompt }] },
  outputs: { choices: [{ message: { role: "assistant", content: completion } }] },
  ...extra,
});
const toolCall = (name, input, output, ms, extra = {}) => ({
  name, runType: "tool", durationMs: ms, inputs: input, outputs: output, ...extra,
});

const TRACES = [
  trace({
    name: "web2app.generate_app_config",
    startedAgoMin: 190,
    customer: "sidehop",
    inputs: { site_url: "https://sidehop.app", platform: "ios" },
    outputs: { bundle_id: "app.sidehop.ios", display_name: "Sidehop", primary_color: "#0F766E", tabs: 4 },
    children: [
      toolCall("fetch_site_manifest", { url: "https://sidehop.app" }, { title: "Sidehop — earn on the side", theme_color: "#0F766E", icons: 3 }, 820),
      llmCall("claude-haiku-4-5", "Derive an iOS app config from this manifest…", '{"bundle_id":"app.sidehop.ios","display_name":"Sidehop","primary_color":"#0F766E","tabs":4}', 1430),
    ],
  }),
  trace({
    name: "web2app.generate_app_config",
    startedAgoMin: 175,
    customer: "sidehop",
    inputs: { site_url: "https://sidehop.app", platform: "android" },
    outputs: { bundle_id: "app.sidehop.android", display_name: "Sidehop", primary_color: "#0F766E", tabs: 4 },
    children: [
      toolCall("fetch_site_manifest", { url: "https://sidehop.app" }, { title: "Sidehop — earn on the side", theme_color: "#0F766E", icons: 3 }, 760),
      llmCall("claude-haiku-4-5", "Derive an Android app config from this manifest…", '{"bundle_id":"app.sidehop.android","display_name":"Sidehop","primary_color":"#0F766E","tabs":4}', 1210),
    ],
  }),
  // The "AI did something weird" case: no error anywhere, but the assistant
  // told the customer their app is live when the tool said not_submitted.
  trace({
    name: "support.ai_reply",
    startedAgoMin: 95,
    customer: "sidehop",
    inputs: { question: "Is my Android app live on the Play Store yet?" },
    outputs: { reply: "Great news — your Android app went live on the Play Store on Tuesday! 🎉" },
    metadata: { channel: "in-app-chat" },
    children: [
      toolCall("lookup_app_status", { customer_slug: "sidehop", platform: "android" }, { status: "broken", store_status: "in_review", last_build: "failed" }, 210),
      llmCall("claude-haiku-4-5", "Customer asks: Is my Android app live on the Play Store yet? Tool result: {status: broken, store_status: in_review, last_build: failed}. Reply helpfully.", "Great news — your Android app went live on the Play Store on Tuesday! 🎉", 980),
    ],
  }),
  // A plain failure: the site fetch timed out, the chain errored.
  trace({
    name: "web2app.extract_site_manifest",
    startedAgoMin: 42,
    customer: "firedrill",
    inputs: { site_url: "https://firedrill.example" },
    error: "TimeoutError: fetch_site_manifest exceeded 30000ms",
    children: [
      toolCall("fetch_site_manifest", { url: "https://firedrill.example" }, undefined, 30_000, { error: "TimeoutError: fetching https://firedrill.example took longer than 30000ms" }),
    ],
  }),
  trace({
    name: "web2app.generate_icon",
    startedAgoMin: 20,
    customer: "firedrill",
    inputs: { display_name: "Firedrill Demo", primary_color: "#DC2626" },
    outputs: { icon_url: "https://assets.example/firedrill/icon-1024.png", sizes: [1024, 180, 120] },
    children: [
      llmCall("claude-haiku-4-5", "Describe a flat app icon for 'Firedrill Demo' in #DC2626…", "A white flame silhouette centered on a #DC2626 rounded square.", 640),
      toolCall("render_icon", { prompt: "white flame on #DC2626", size: 1024 }, { url: "https://assets.example/firedrill/icon-1024.png" }, 2100),
    ],
  }),
];

const post = TRACES.flat();
if (DRY) {
  console.log(JSON.stringify({ project: PROJECT, runs: post.length, sample: post[0] }, null, 2));
  process.exit(0);
}

const res = await fetch(`${ENDPOINT}/runs/batch`, { method: "POST", headers, body: JSON.stringify({ post }) });
if (!res.ok) {
  console.error(`ingest failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`ingested ${post.length} runs across ${TRACES.length} traces into project "${PROJECT}" (HTTP ${res.status})`);

// Ingestion is asynchronous; poll until the root runs are queryable.
const sessions = await (await fetch(`${ENDPOINT}/sessions?name=${encodeURIComponent(PROJECT)}`, { headers })).json();
const project = Array.isArray(sessions) ? sessions.find((s) => s.name === PROJECT) : null;
if (!project) {
  console.error("project not visible yet — re-run the lookup in a minute: GET /sessions?name=" + PROJECT);
  process.exit(1);
}
let roots = 0;
for (let attempt = 0; attempt < 12 && roots < TRACES.length; attempt++) {
  await new Promise((r) => setTimeout(r, 5000));
  const q = await fetch(`${ENDPOINT}/runs/query`, { method: "POST", headers, body: JSON.stringify({ session: [project.id], is_root: true, limit: 50 }) });
  roots = q.ok ? ((await q.json()).runs ?? []).length : 0;
  process.stdout.write(`  visible root runs: ${roots}/${TRACES.length}\r`);
}
console.log(`\nvisible root runs: ${roots}/${TRACES.length}`);

const ws = await (await fetch(`${ENDPOINT}/workspaces`, { headers })).json().catch(() => null);
const workspaceId = Array.isArray(ws) ? ws[0]?.id : ws?.id;
console.log(`
Paste into apps/worker/.dev.vars (overrides wrangler.jsonc vars locally):
LANGSMITH_PROJECT_ID=${project.id}
LANGSMITH_PROJECT_NAME=${PROJECT}
LANGSMITH_WORKSPACE_ID=${workspaceId ?? "<see LangSmith settings>"}
LANGSMITH_API_KEY=<the key you just used>

For the deployed Worker: set the first three in wrangler.jsonc "vars" and
  printf '%s' '<key>' | pnpm exec wrangler secret put LANGSMITH_API_KEY
Try it: langsmith.searchTraces({ query: "support.ai_reply", limit: 5 }) then langsmith.trace(<id>).`);
