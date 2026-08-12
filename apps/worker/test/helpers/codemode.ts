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
  memoryFacts?: Array<{ factId: string; fact: string; episodeUuids: string[] }>;
  citations?: Array<{ factId: string; fact: string; permalink: string; ts: string }>;
  supabaseRows?: Array<Record<string, string | number | boolean | null>>;
  logLines?: Array<{ at: string; level: string; message: string }>;
};

export function fakeDeps(fixtures: FakeFixtures = {}): CapabilityDependencies {
  return {
    db: undefined as never, // no capability in Task 5 touches D1 directly
    slack: {
      async thread() { return fixtures.slackThread ?? []; },
      async searchMessages() { return []; },
      async reply() { return { ts: "1.0", permalink: null }; },
    },
    memory: {
      async ensureGraph() {},
      async addMessage() { return { episodeUuid: "ep_0" }; },
      async search() { return fixtures.memoryFacts ?? []; },
    },
    linear: {
      async createIssue() { return { id: "iss_1", identifier: "FF-1", url: "https://x" }; },
      async findIssue() { return null; },
      async updateIssue() { return { id: "iss_1", url: "https://x" }; },
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
    clock: () => 0,
  };
}
