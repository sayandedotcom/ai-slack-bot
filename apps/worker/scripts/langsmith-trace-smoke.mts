/**
 * One real trace, written by the REAL tracer, then read back.
 *
 * Settles the questions the unit tests structurally cannot: whether LangSmith
 * accepts this exact wire shape, whether it ORDERS on our 3-digit `dotted_order`
 * segments rather than merely accepting them, and how long ingest takes to
 * become visible. All three matter before anyone records a demo.
 *
 * Reads LANGSMITH_API_KEY from the environment for this one command, on purpose
 * — not from .dev.vars. Writes to a throwaway project so the demo project stays
 * clean:
 *
 *   LANGSMITH_API_KEY=... pnpm exec tsx scripts/langsmith-trace-smoke.mts [project]
 */
import { makeLangSmithTracer } from "../src/langsmith/tracer";

const KEY = process.env.LANGSMITH_API_KEY;
const ENDPOINT = "https://api.smith.langchain.com";
const PROJECT = process.argv[2] ?? "fire-fighter-smoke";

if (!KEY) {
  console.error("LANGSMITH_API_KEY is not set for this command.");
  process.exit(2);
}

let at = Date.now();
const tracer = makeLangSmithTracer(
  { endpoint: ENDPOINT, apiKey: KEY, project: PROJECT, enabled: true, payloads: "redacted" },
  () => at,
);

const root = tracer.startRoot({
  runId: "smoke-run",
  generationId: "smoke-gen",
  agentTurnId: "smoke-turn",
  attempt: 1,
  surface: "chat",
  startedAtMs: at,
});
// Two llm spans and a tool span between them — the shape a real incident makes,
// and the one whose ORDER we need LangSmith to preserve.
const llm1 = tracer.startLlm(root, {
  stepNumber: 0, globalStep: 0, modelId: "claude-fable-5", provider: "anthropic",
  startedAtMs: at, promptText: "why are the exports empty?",
});
at += 1_100;
tracer.endLlm(llm1, {
  endedAtMs: at,
  usage: { inputTokens: 910, outputTokens: 120, cachedInputTokens: 400 },
  costNanoUsd: 42_000, latencyMs: 1_100,
  finishReason: "tool-calls", rawFinishReason: "tool_use",
  providerRequestId: "req_smoke", gatewayLogId: "log_smoke", errorCode: null,
  outputText: "Let me check the deploy logs.",
});
const tool = tracer.startTool(root, {
  toolName: "run_code", toolCallId: "call_1", startedAtMs: at,
  code: "async () => betterstack.logs({ query: 'export' })",
});
at += 700;
tracer.endTool(tool, {
  endedAtMs: at, ok: true, durationMs: 700, capabilityCalls: 2, errorCode: null,
  resultPreview: '[{"level":"error","message":"export worker gone"}]',
});
const llm2 = tracer.startLlm(root, {
  stepNumber: 1, globalStep: 1, modelId: "claude-fable-5", provider: "anthropic",
  startedAtMs: at, promptText: "(tool result)",
});
at += 900;
tracer.endLlm(llm2, {
  endedAtMs: at,
  usage: { inputTokens: 1_400, outputTokens: 60 },
  costNanoUsd: 51_000, latencyMs: 900,
  finishReason: "stop", rawFinishReason: "end_turn",
  providerRequestId: "req_smoke_2", gatewayLogId: "log_smoke_2", errorCode: null,
  outputText: "The 04:12 deploy dropped the export worker.",
});
at += 40;
tracer.endRoot(root, {
  endedAtMs: at, path: "completed", errorCode: null, finalTurnId: "smoke:final",
});

// The tracer deliberately swallows the response body (it must never log one),
// so surface it here — this script exists to diagnose exactly that.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const res = await realFetch(url as never, init as never);
  if (!res.ok) {
    const clone = res.clone();
    console.error(`\n${init.method} ${url} -> HTTP ${res.status}\n${await clone.text()}\n`);
    if (process.env.DUMP_BODY === "1") {
      const parsed = JSON.parse(String(init.body)) as { post: unknown[] };
      console.error("first run posted:\n", JSON.stringify(parsed.post[0], null, 2));
    }
  }
  return res;
}) as typeof fetch;

const report = await tracer.flush();
console.log("flush ->", report, "\ntrace  ->", tracer.traceId);
if (report.outcome !== "sent") process.exit(1);

// How long until it is queryable, and does the tree come back in order?
const headers = { "x-api-key": KEY, "content-type": "application/json" };
const startedWaiting = Date.now();
for (let attempt = 1; attempt <= 12; attempt += 1) {
  await new Promise((r) => setTimeout(r, 1_000));
  const res = await fetch(`${ENDPOINT}/runs/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ trace: tracer.traceId, limit: 20 }),
  });
  const body = (await res.json()) as { runs?: Array<Record<string, unknown>> };
  const runs = body.runs ?? [];
  if (runs.length === 0) continue;

  console.log(`visible after ~${Math.round((Date.now() - startedWaiting) / 1000)}s, ${runs.length} runs`);
  const ordered = [...runs].sort((a, b) =>
    String(a.dotted_order).localeCompare(String(b.dotted_order)));
  for (const run of ordered) {
    console.log(
      `  ${String(run.run_type).padEnd(5)} ${String(run.name).padEnd(12)}`,
      `parent=${run.parent_run_id === null || run.parent_run_id === undefined ? "-" : "root"}`,
      `err=${run.error ?? "-"}`,
    );
  }
  const names = ordered.map((r) => String(r.name));
  const expected = ["run chat", "step 0", "run_code", "step 1"];
  console.log("order preserved:", JSON.stringify(names) === JSON.stringify(expected));
  if (JSON.stringify(names) !== JSON.stringify(expected)) console.log("  expected:", expected);
  process.exit(0);
}
console.log("not visible after 12s — ingest is slower than that, or the query shape is wrong");
