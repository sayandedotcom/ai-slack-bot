import {
  alwaysFresh,
  type AgentExecutionGuard,
  type CapabilityCompleted,
  type CapabilityEvent,
  type CapabilityFailed,
  type CapabilityStarted,
  type CodeModeLimits,
  type CodeModeScope,
} from "../../src/codemode/contracts";
import {
  newCodeExecution,
  type CodeExecution,
} from "../../src/codemode/bindings/shared";
import type { CapabilityDependencies } from "../../src/codemode/gateways";

// Re-exported rather than reimplemented: the call budget is production policy,
// and a test-local copy would drift from the thing it is meant to verify.
export { newCallCounter } from "../../src/codemode/bindings/shared";

/**
 * Small caps so budget and size limits are reachable in a unit test without
 * building a 24KB fixture. Shape must stay identical to PRODUCTION_LIMITS —
 * the type is what enforces that.
 */
export const TEST_LIMITS: CodeModeLimits = {
  maxCodeChars: 2_000,
  wallTimeMs: 200,
  cpuMs: 50,
  subRequests: 4,
  maxResultChars: 2_000,
  maxConsoleChars: 2_000,
  maxCapabilityCalls: 8,
};

export type FakeAuditSink = {
  events: CapabilityEvent[];
  started(event: CapabilityStarted): Promise<void>;
  completed(event: CapabilityCompleted): Promise<void>;
  failed(event: CapabilityFailed): Promise<void>;
};

/**
 * Records events in call order. Order is the assertion that matters: a
 * `completed` without a preceding `started`, or two terminal events for one
 * call, is the shape of a double-charged effect.
 */
export function fakeAuditSink(): FakeAuditSink {
  const events: CapabilityEvent[] = [];
  return {
    events,
    async started(event) {
      events.push(event);
    },
    async completed(event) {
      events.push(event);
    },
    async failed(event) {
      events.push(event);
    },
  };
}

/**
 * The state of one `run_code` execution, for tests that drive `buildRegistry`
 * directly instead of going through the tool.
 *
 * Built through the production constructor, so a field added to `CodeExecution`
 * cannot be quietly missing here. Each call mints a distinct outer tool call id
 * — two executions in one test must never look like the same one, which is the
 * whole property this helper's callers depend on.
 */
export function testExecution(input: {
  audit: FakeAuditSink;
  limits?: CodeModeLimits;
  guard?: AgentExecutionGuard;
  outerToolCallId?: string;
  abortSignal?: AbortSignal;
} ): CodeExecution {
  return newCodeExecution({
    outerToolCallId: input.outerToolCallId ?? `call_${crypto.randomUUID()}`,
    audit: input.audit,
    guard: input.guard ?? alwaysFresh(),
    limits: input.limits ?? TEST_LIMITS,
    clock: () => 0,
    abortSignal: input.abortSignal,
  });
}

/** A well-formed Slack scope. Individual tests override the fields they care about. */
export const slackScope: CodeModeScope = {
  runId: "run_1",
  turnId: "turn_1",
  origin: "slack",
  shadow: false,
  customerSlug: "acme",
  slackThread: { channelId: "C123", threadTs: "1712345678.000100" },
  actor: { engineerEmail: "eng@example.com", slackUserId: "U1" },
};

/* --------------------------------------------------- write-permitted scope -- */

/**
 * Seed D1 so a scope actually PASSES the shared write guard.
 *
 * From Task 6 on, every `external_write` capability — Slack, Linear and files
 * alike — re-reads the channel policy and the `runs` row immediately before it
 * acts. A scope invented in TypeScript therefore denies by default: its channel
 * is unmapped (`observe`) and its run id names no row, which is the correct
 * fail-closed answer and exactly what the guard's own tests assert.
 *
 * That default is right, and it is why this helper exists. A suite about Linear
 * issue bodies or artifact hashing should be testing Linear issue bodies or
 * artifact hashing — not accidentally re-testing the write guard, and not
 * quietly passing because it never reached its own subject. Call this when the
 * case is about what a permitted write DOES; pass a hand-built scope when the
 * case is about a write being refused.
 *
 * Storage is shared across files (test/setup.ts migrates once), so every call
 * mints its own channel, thread and run and nothing here counts rows.
 */
export async function seedPermittedScope(
  db: D1Database,
  overrides: Partial<CodeModeScope> = {},
): Promise<CodeModeScope> {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const threadTs = `17123456${Math.floor(10 + Math.random() * 89)}.000100`;
  const runId = `run_${crypto.randomUUID()}`;
  const customerSlug = overrides.customerSlug ?? "acme";

  await db
    .prepare("INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, 'live')")
    .bind(channelId, `chan-${channelId}`, customerSlug)
    .run();
  await db
    .prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
       VALUES (?, ?, 'slack', ?, ?, 'live', 0, 0, 0)`,
    )
    .bind(runId, `slack:${channelId}:${threadTs}`, channelId, threadTs)
    .run();

  return {
    ...slackScope,
    runId,
    // Fresh per call: every write goes through the effect ledger, so a reused
    // turn would make the second identical call REPLAY the first rather than
    // reach the subject under test.
    turnId: `turn_${crypto.randomUUID()}`,
    customerSlug,
    slackThread: { channelId, threadTs },
    ...overrides,
  };
}

/**
 * Gateways that answer with empty, well-shaped results.
 *
 * Deliberately not mocks of the real vendors. What these prove is that the
 * registry, validation and audit path work with no credential present at all —
 * which is the property that lets Tasks 6-12 be reviewed before any live
 * account is wired up.
 */
export type FakeFixtures = {
  slackThread?: Array<{ ts: string; userId: string | null; text: string; permalink: string | null }>;
  /**
   * What `slack.searchMessages` returns. Carries `eventId` because the real D1
   * gateway does, and because provenance registration reads exactly that field.
   */
  slackSearch?: Array<{
    ts: string;
    userId: string | null;
    text: string;
    permalink: string | null;
    eventId?: string;
  }>;
  memoryFacts?: Array<{ factId: string; fact: string; episodeUuids: string[] }>;
  citations?: Array<{ factId: string; fact: string; permalink: string; ts: string }>;
  supabaseRows?: Array<Record<string, string | number | boolean | null>>;
  logLines?: Array<{ at: string; level: string; message: string }>;
  /** Override the default in-memory `ApprovalPort` double. */
  approval?: CapabilityDependencies["approval"];
};

export function fakeDeps(fixtures: FakeFixtures = {}): CapabilityDependencies {
  return {
    db: undefined as never, // no capability in Task 5 touches D1 directly
    slack: {
      async thread() { return fixtures.slackThread ?? []; },
      async searchMessages() { return fixtures.slackSearch ?? []; },
      async reply() { return { ts: "1.0", permalink: null }; },
    },
    memory: {
      async ensureGraph() {},
      async addEpisode() { return { episodeUuid: "ep_0" }; },
      async addMessage() { return { episodeUuid: "ep_0" }; },
      async search() { return fixtures.memoryFacts ?? []; },
    },
    linear: {
      async createIssue() { return { id: "iss_1", identifier: "FF-1", url: "https://x" }; },
      async findIssue() { return null; },
      async updateIssue() { return { id: "iss_1", url: "https://x" }; },
      async resolveLinkTargets(issueIds) {
        return issueIds.map((id) => ({ id, identifier: "FF-1" }));
      },
    },
    supabase: {
      async describe() { return []; },
      async select() { return fixtures.supabaseRows ?? []; },
    },
    langsmith: {
      async trace() {
        return { traceId: "t", name: "n", startedAt: "2026-08-12T00:00:00Z", status: "ok", nodes: [], truncated: false };
      },
      async searchTraces() { return []; },
    },
    betterstack: {
      async logs() { return fixtures.logLines ?? []; },
      async monitors() { return []; },
    },
    files: {
      async publish() { return { url: "https://x", size: 0, sha256: "0".repeat(64) }; },
    },
    approval: fixtures.approval ?? fakeApprovalPort(),
    sandbox: fakeSandboxGateway(),
    // Phase 20's transport, faked the same way `linear` above is: empty,
    // well-shaped results with no credential in reach. The real REST sequence
    // is `test/github-gateway.test.ts`'s job.
    github: {
      async openPR() {
        return { number: 1, url: "https://github.com/x/y/pull/1", headRef: "fix/x", author: "bot", updated: false };
      },
      async findPR() { return null; },
      async checkPR() {
        return {
          state: "open",
          url: "https://github.com/x/y/pull/1",
          headRef: "fix/x",
          baseRef: "staging",
          linearLinkback: { commented: false, identifiers: [] },
        };
      },
    },
    clock: () => 0,
  };
}

/**
 * A container that is up and does nothing.
 *
 * Deliberately NOT the real gateway over a fake handle: that composition is
 * what `codemode-sandbox.test.ts` is for, and every other suite here only needs
 * the namespace to build and classify without a container runtime in reach. It
 * reports `ready` so a suite that stumbles into a sandbox call gets a shaped
 * result rather than a readiness error it has no context for.
 */
export function fakeSandboxGateway(): CapabilityDependencies["sandbox"] {
  return {
    async boot() {
      return {
        state: "ready",
        commit: null,
        repoPath: "/repo",
        elapsedMs: 0,
        note: "ready",
      };
    },
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async spawn() {
      return { processId: "proc_0" };
    },
    async checkProcess() {
      return { running: false, exitCode: 0, stdoutTail: "", stderrTail: "" };
    },
    async killProcess() {
      return { killed: false };
    },
    async readFile() {
      return { content: "" };
    },
    async writeFile() {
      return { bytesWritten: 0 };
    },
    async preview() {
      return { url: "https://example.invalid" };
    },
    async diff() {
      return {
        preview: "",
        truncated: false,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        diffRef: null,
      };
    },
    // Phase 19's three, same "up and does nothing" contract as the rest of
    // this fake: a suite that only builds and classifies the `browser`
    // namespace gets a shaped result rather than an error it has no context
    // for. `codemode-browser.test.ts` overrides these per case.
    async readBinary() {
      return {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        size: 0,
      };
    },
    async record() {
      return { recordingId: "rec_0" };
    },
    async checkRecording() {
      return { state: "passed", url: "https://example.invalid/rec_0.mp4", error: null, stdoutTail: "", durationMs: 0 };
    },
  };
}

/**
 * A test double of `ApprovalPort`, in-memory and closed over by the test.
 *
 * Namespaced to keep the "which of the seven other adapters made the fixture
 * odd" question off the table for every suite that only wants a well-behaved
 * approval port and doesn't care about it.
 */
export function fakeApprovalPort(): CapabilityDependencies["approval"] {
  let open: { approvalId: string } | null = null;
  return {
    async open(input) {
      void input;
      const approvalId = `apr:${crypto.randomUUID()}`;
      open = { approvalId };
      return { approvalId };
    },
    openApprovalId() {
      return open?.approvalId ?? null;
    },
    async withdraw() {
      open = null;
      return { withdrawn: true };
    },
  };
}
