/// <reference path="../../src/codemode/generated/capabilities.d.ts" />

/**
 * A representative model program, compiled against the generated declarations.
 *
 * This is not a unit test — it is never executed. It is checked by
 * `pnpm typecheck`, which makes it the thing that catches a duplicate type
 * alias or a capability whose types silently degraded, even if the assertions
 * in codemode-dts.test.ts were ever deleted.
 *
 * Runtime Zod tests remain required. Model-visible types are GUIDANCE to the
 * model, not a security boundary: the sandbox executes JavaScript and nothing
 * stops it calling a method these types forbid. The boundary is the parse
 * inside defineCapability(); this file is the signpost.
 */

// Every namespace, at least one return field each — this must compile.
export async function representativeProgram() {
  const thread = await slack.thread({ limit: 20 });
  const hits = await slack.searchMessages({ query: "timeout", limit: 5 });
  const facts = await memory.recall({ query: "billing", scope: "customer" });
  const cites = await memory.cite({ factIds: facts.map((f) => f.factId) });
  const rows = await supabase.select({ resource: "invoices", limit: 10 });
  const traces = await langsmith.searchTraces({ limit: 3 });
  const logs = await betterstack.logs({ query: "level:error", since: "2026-08-11T00:00:00Z" });
  const monitors = await betterstack.monitors({});
  return {
    first: thread[0]?.text ?? null,
    hitCount: hits.length,
    citations: cites.length,
    rowCount: rows.length,
    traceId: traces[0]?.traceId ?? null,
    logLine: logs[0]?.message ?? null,
    monitorCount: monitors.length,
  };
}

// The model must not be able to express these. Each @ts-expect-error FAILS the
// build if the declaration ever starts allowing it.
export async function forbidden() {
  // @ts-expect-error — targeting another destination is not expressible
  await slack.reply({ text: "hi", channel: "C_OTHER" });
  // @ts-expect-error — acting as someone else is not expressible
  await slack.reply({ text: "hi", actor: "U_SOMEONE" });
  // @ts-expect-error — where an issue is filed is pinned server-side
  await linear.createIssue({ title: "t", description: "d", teamId: "T_OTHER" });
  // @ts-expect-error — no free-form query text
  await supabase.select({ resource: "invoices", sql: "DROP TABLE users" });
  // @ts-expect-error — no host or project selection
  await langsmith.searchTraces({ baseUrl: "https://evil.example" });
  // @ts-expect-error — misspelled method
  await slack.serch({ query: "x" });
  // @ts-expect-error — out-of-range enum
  await memory.recall({ query: "q", scope: "everything" });
  // @ts-expect-error — there is no memory write capability in Phase 09
  await memory.remember({ fact: "invented" });
}
