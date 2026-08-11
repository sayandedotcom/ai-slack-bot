import type {
  CapabilityCompleted,
  CapabilityEvent,
  CapabilityFailed,
  CapabilityStarted,
  CodeModeLimits,
  CodeModeScope,
} from "../../src/codemode/contracts";
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
export function fakeDeps(): CapabilityDependencies {
  return {
    db: undefined as never, // no capability in Task 5 touches D1 directly
    slack: {
      async thread() { return []; },
      async searchMessages() { return []; },
      async reply() { return { ts: "1.0", permalink: null }; },
    },
    memory: {
      async ensureGraph() {},
      async addMessage() { return { episodeUuid: "ep_0" }; },
      async search() { return []; },
    },
    linear: {
      async createIssue() { return { id: "iss_1", identifier: "FF-1", url: "https://x" }; },
      async findIssue() { return null; },
      async updateIssue() { return { id: "iss_1", url: "https://x" }; },
    },
    supabase: {
      async describe() { return []; },
      async select() { return []; },
    },
    langsmith: {
      async trace() {
        return { traceId: "t", name: "n", startedAt: "2026-08-12T00:00:00Z", status: "ok", nodes: [], truncated: false };
      },
      async searchTraces() { return []; },
    },
    betterstack: {
      async logs() { return []; },
      async monitors() { return []; },
    },
    files: {
      async publish() { return { url: "https://x", size: 0, sha256: "0".repeat(64) }; },
    },
    clock: () => 0,
  };
}
