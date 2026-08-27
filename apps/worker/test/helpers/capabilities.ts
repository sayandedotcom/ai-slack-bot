/**
 * A BindingContext for tests.
 *
 * Every gateway throws by default: a namespace test that accidentally reaches a
 * vendor it did not stub fails loudly instead of silently hitting the network.
 * The pool binds synthetic credentials, so a real call would not even fail in
 * an obvious way.
 */
import { env } from "cloudflare:test";

import type { CapabilityEvent } from "../../src/capabilities/audit";
import {
  type AgentExecutionGuard,
  alwaysFresh,
  newCodeExecution,
  PRODUCTION_LIMITS,
} from "../../src/capabilities/execution";
import type { BindingContext } from "../../src/capabilities/registry";
import type { CapabilityDependencies } from "../../src/gateways/ports";
import type { RunScope } from "../../src/gateways/scope";

export function unreachableDependencies(
  overrides: Partial<CapabilityDependencies> = {}
): CapabilityDependencies {
  const gateway = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, method) => () => {
        throw new Error(
          `test reached ${name}.${String(method)} without stubbing it`
        );
      },
    });

  return {
    db: env.DB,
    slack: gateway("slack") as never,
    memory: gateway("memory") as never,
    linear: gateway("linear") as never,
    supabase: gateway("supabase") as never,
    langsmith: gateway("langsmith") as never,
    betterstack: gateway("betterstack") as never,
    files: gateway("files") as never,
    approval: gateway("approval") as never,
    sandbox: gateway("sandbox") as never,
    github: gateway("github") as never,
    clock: () => Date.now(),
    ...overrides,
  };
}

export function testScope(overrides: Partial<RunScope> = {}): RunScope {
  return {
    runId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    origin: "chat",
    shadow: false,
    customerSlug: null,
    slackThread: null,
    actor: null,
    ...overrides,
  };
}

export function testBindingContext(
  options: {
    scope?: Partial<RunScope>;
    deps?: Partial<CapabilityDependencies>;
    guard?: AgentExecutionGuard;
    events?: CapabilityEvent[];
  } = {}
): BindingContext {
  const events = options.events ?? [];
  return {
    scope: testScope(options.scope),
    deps: unreachableDependencies(options.deps),
    limits: PRODUCTION_LIMITS,
    execution: newCodeExecution({
      outerToolCallId: `tc-${crypto.randomUUID().slice(0, 8)}`,
      audit: {
        started: async (e) => void events.push(e),
        completed: async (e) => void events.push(e),
        failed: async (e) => void events.push(e),
      },
      guard: options.guard ?? alwaysFresh(),
      limits: PRODUCTION_LIMITS,
      clock: () => Date.now(),
    }),
  };
}
