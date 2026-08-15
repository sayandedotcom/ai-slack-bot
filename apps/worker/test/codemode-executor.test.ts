import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { guardLoader } from "../src/codemode/guarded-loader";
import { makeGuardedExecutor } from "../src/codemode/executor";
import { TEST_LIMITS } from "./helpers/codemode";

const executor = (patch: Partial<typeof TEST_LIMITS> = {}) =>
  makeGuardedExecutor(
    guardLoader(env.LOADER, { ...TEST_LIMITS, ...patch }),
    { ...TEST_LIMITS, ...patch },
    () => Date.now(),
  );

describe("wall-clock bounding", () => {
  it("returns a fast result well inside the budget", async () => {
    const out = await executor().execute("async () => 41 + 1", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBe(42);
  });

  it("times out a sandbox that sleeps past the budget", async () => {
    const started = Date.now();
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { await new Promise(r => setTimeout(r, 5000)); return 'late'; }", [],
    );
    expect(out.error).toMatch(/execution_timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  /**
   * The timeout message must say that completed writes SURVIVED, not merely
   * that the program was abandoned.
   *
   * This is a regression test for a defect that reached customers twice in live
   * drills: a `run_code` block sent a Slack reply, ran past the wall, and was
   * abandoned. The reply had already posted, but the model read "abandoned",
   * concluded the send failed, reworded it and sent it again — and a reworded
   * message is different text, so it is a genuinely different effect and the
   * ledger correctly declined to dedupe it. The customer was told the same
   * thing twice, 28 seconds apart.
   *
   * The fix is this sentence, so the test is on the sentence. Asserting the
   * error CODE alone would have passed throughout the entire bug.
   */
  it("tells the model that writes already made survived the timeout", async () => {
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { await new Promise(r => setTimeout(r, 5000)); return 'late'; }", [],
    );
    expect(out.error).toMatch(/execution_timeout/);
    // The load-bearing half: what happened to effects that already returned.
    expect(out.error).toMatch(/HAS TAKEN EFFECT/);
    expect(out.error).toMatch(/Do not assume the work was lost/i);
    // And the instruction that keeps a retry dedupable rather than additive.
    expect(out.error).toMatch(/SAME arguments/);
  });

  it("times out when a host capability never resolves", async () => {
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { await slack.thread({}); return 'never'; }",
      [{ name: "slack", fns: { thread: () => new Promise(() => {}) } }],
    );
    expect(out.error).toMatch(/execution_timeout/);
  });

  // The case the package's in-sandbox timer cannot catch: no yield, no timer.
  //
  // SKIPPED LOCALLY, AND THE REASON MATTERS. Measured 2026-08-12: the parent
  // race does return execution_timeout on schedule, so the assertion below
  // would pass. But the isolate is never killed -- limits.cpuMs is not
  // enforced under @cloudflare/vitest-pool-workers any more than under
  // `wrangler dev` -- so it keeps spinning at ~75% CPU and starves the workerd
  // process. Every later test in the runtime then hangs, including vitest's
  // own testTimeout, which needs that runtime to fire. Running this locally
  // wedges the suite; it does not fail it.
  //
  // DynamicWorkerExecutor.execute() creates and owns the WorkerStub, so there
  // is no host-side handle to dispose. Only a real workerd CPU limit ends it.
  // The claim "workerd itself kills a CPU burn" is therefore verified DEPLOYED
  // in Task 14 Step 7 -- which is where this plan's own Step 6 table already
  // assigns it. See docs/superpowers/plans/phase-09-notes.md, Task 4b.
  it.skip("bounds a CPU-bound loop that never yields (deployed-only: Task 14 Step 7)", async () => {
    const started = Date.now();
    const out = await executor({ wallTimeMs: 500 }).execute(
      "async () => { while (true) {} }", [],
    );
    expect(out.error).toMatch(/execution_timeout|execution_cpu_limit/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  // The safe local half of the claim above: a program that yields is bounded by
  // the parent race and leaves nothing spinning behind it.
  it("bounds a busy loop that yields to the event loop", async () => {
    const started = Date.now();
    const out = await executor({ wallTimeMs: 400 }).execute(
      "async () => { while (true) { await new Promise(r => setTimeout(r, 0)); } }", [],
    );
    expect(out.error).toMatch(/execution_timeout/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("does not surface the losing race as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => { seen.push(e.reason); e.preventDefault(); };
    addEventListener("unhandledrejection", onUnhandled as EventListener);
    await executor({ wallTimeMs: 200 }).execute(
      "async () => { await new Promise(r => setTimeout(r, 2000)); return 1; }", [],
    );
    await new Promise((r) => setTimeout(r, 400));
    removeEventListener("unhandledrejection", onUnhandled as EventListener);
    expect(seen).toEqual([]);
  });

  it("never throws across the Executor interface", async () => {
    // Syntactically broken code is the cheapest way to reach the package's own
    // failure path; it must still come back as a value, not a rejection.
    await expect(executor().execute("this is not valid javascript(", []))
      .resolves.toHaveProperty("error");
  });
});

describe("result bounding", () => {
  it("preserves a small structured result exactly", async () => {
    const out = await executor().execute(
      "async () => ({ ok: true, items: ['a','b'], n: 3 })", []);
    expect(out.result).toEqual({ ok: true, items: ["a", "b"], n: 3 });
  });

  it("returns a marked preview for an oversized string", async () => {
    const out = await executor({ maxResultChars: 200 }).execute(
      "async () => 'x'.repeat(50000)", []);
    expect(String(out.result)).toContain("TRUNCATED");
    expect(String(out.result).length).toBeLessThan(2000);
  });

  it("returns a marked preview for an oversized object", async () => {
    const out = await executor({ maxResultChars: 200 }).execute(
      "async () => Array.from({length: 5000}, (_, i) => ({ i, pad: 'y'.repeat(50) }))", []);
    expect(String(out.result)).toContain("TRUNCATED");
  });

  it.each([
    ["a cycle", "async () => { const a = {}; a.self = a; return a; }"],
    ["a bigint", "async () => 1n"],
    ["a function", "async () => (() => 1)"],
  ])("turns %s into a readable error, not a crash", async (_label, code) => {
    const out = await executor().execute(code, []);
    expect(out.error).toMatch(/invalid_input|output_too_large/);
  });

  it("refuses a binary final result — files.publish is the only binary path", async () => {
    const out = await executor().execute("async () => new Uint8Array([1,2,3])", []);
    expect(out.error).toMatch(/invalid_input/);
  });

  it("returns null rather than undefined when code returns nothing", async () => {
    const out = await executor().execute("async () => { }", []);
    expect(out.error).toBeUndefined();
    expect(out.result).toBeNull();
  });
});

describe("log bounding", () => {
  it("captures log, warn and error with their level", async () => {
    const out = await executor().execute(
      "async () => { console.log('a'); console.warn('b'); console.error('c'); return 1; }", []);
    expect(out.logs?.join("\n")).toMatch(/a[\s\S]*\[warn\] b[\s\S]*\[error\] c/);
  });

  it("caps many lines and marks the truncation deterministically", async () => {
    const out = await executor({ maxConsoleChars: 500 }).execute(
      "async () => { for (let i = 0; i < 5000; i++) console.log('line ' + i); return 'done'; }", []);
    expect(out.result).toBe("done");
    expect(out.logs!.join("\n").length).toBeLessThan(2000);
    expect(out.logs!.join("\n")).toContain("TRUNCATED");
  });

  it("does not let one enormous line bypass the byte cap", async () => {
    const out = await executor({ maxConsoleChars: 500 }).execute(
      "async () => { console.log('z'.repeat(200000)); return 'done'; }", []);
    expect(out.logs!.join("\n").length).toBeLessThan(2000);
  });

  it("preserves bounded logs even when the run times out", async () => {
    const out = await executor({ wallTimeMs: 300 }).execute(
      "async () => { console.log('before'); await new Promise(r => setTimeout(r, 5000)); }", []);
    expect(out.error).toMatch(/execution_timeout/);
    // Logs may be absent when the parent race wins — assert we never invent them.
    if (out.logs?.length) expect(out.logs.join("\n")).toContain("before");
  });
});
