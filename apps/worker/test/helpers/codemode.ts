import type {
  CapabilityCompleted,
  CapabilityEvent,
  CapabilityFailed,
  CapabilityStarted,
  CodeModeLimits,
} from "../../src/codemode/contracts";

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
