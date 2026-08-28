import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { capabilityEffectOf } from "../../src/capabilities/define";
import {
  type BindingContext,
  buildConnectors,
  buildNamespaces,
  CAPABILITY_NAMESPACES,
} from "../../src/capabilities/registry";
import type { MemoryStore } from "../../src/memory/store";
import { testBindingContext } from "../helpers/capabilities";

describe("capability registry", () => {
  it("classifies every method with an effect", () => {
    for (const ns of buildNamespaces(testBindingContext())) {
      for (const [method, tool] of Object.entries(ns.tools)) {
        expect(capabilityEffectOf(tool), `${ns.name}.${method}`).not.toBeNull();
      }
    }
  });

  it("keeps every method name globally unique across namespaces", () => {
    // The .d.ts generator types by METHOD NAME alone, with no namespace prefix,
    // so slack.search and langsmith.search would both emit `type SearchInput`
    // and the joined declaration file would not compile. Enforced on the
    // DERIVED PascalCase name, which is what actually collides.
    const seen = new Map<string, string>();
    for (const ns of buildNamespaces(testBindingContext())) {
      for (const method of Object.keys(ns.tools)) {
        const pascal = method.slice(0, 1).toUpperCase() + method.slice(1);
        expect(
          seen.has(pascal),
          `${pascal} also from ${seen.get(pascal)}`
        ).toBe(false);
        seen.set(pascal, ns.name);
      }
    }
  });

  it("renders namespaces in the frozen order", () => {
    // Order is the order the model reads its API in, and the order the
    // committed .d.ts renders. A reshuffle is a reviewable diff, not a nit.
    const built = buildNamespaces(testBindingContext()).map((n) => n.name);
    expect(built).toEqual(
      CAPABILITY_NAMESPACES.filter((n) => built.includes(n))
    );
  });

  it("does not share a call budget between two contexts", () => {
    const a = buildNamespaces(testBindingContext());
    const b = buildNamespaces(testBindingContext());
    expect(a[0]).not.toBe(b[0]);
  });
});

/**
 * The bug that shipped: `buildConnectors` made one connector per namespace and
 * each memoised its context PRIVATELY, so one `run_code` execution got eleven
 * executions — eleven customer-reference maps and eleven call budgets. A
 * reference minted by `memory.findCustomers` was unknown to the `slack`
 * connector that `searchMessages` lives on, which is exactly the hand-off the
 * design routes an internal chat down. Seen live on 2026-08-28: the same
 * `customerRef`, in one code block, accepted by `memory.recall` and refused by
 * `slack.searchMessages` with "not produced in this execution".
 *
 * `memory.test.ts` covers findCustomers -> recall, but both live on the memory
 * connector. This is the cross-namespace case, through the real builder.
 */
describe("buildConnectors — one execution, one context, across namespaces", () => {
  function memoryStore(): MemoryStore {
    return {
      ensureGraph: vi.fn(async () => {}),
      addEpisode: vi.fn(async () => ({ episodeUuid: "ep-1" })),
      addMessage: vi.fn(async () => ({ episodeUuid: "ep-1" })),
      search: vi.fn(async () => []),
    } as unknown as MemoryStore;
  }

  async function seedCustomer(slug: string): Promise<void> {
    const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, 'live')"
    )
      .bind(channelId, slug, slug)
      .run();
  }

  function build() {
    const built: string[] = [];
    const contexts: BindingContext[] = [];
    const searchMessages = vi.fn(async () => []);
    const connectors = buildConnectors(
      {} as ExecutionContext,
      env,
      async (id) => {
        built.push(id);
        const ctx = testBindingContext({
          scope: { origin: "chat" },
          deps: {
            memory: memoryStore(),
            slack: { searchMessages } as never,
          },
        });
        contexts.push(ctx);
        return ctx;
      }
    );
    const byName = (name: string) => {
      const c = connectors.find((x) => x.name() === name);
      if (!c) throw new Error(`no ${name} connector`);
      return c;
    };
    return {
      built,
      contexts,
      searchMessages,
      memory: byName("memory"),
      slack: byName("slack"),
    };
  }

  it("resolves a customerRef minted by memory inside slack.searchMessages", async () => {
    const slug = `acme${crypto.randomUUID().slice(0, 6)}`;
    await seedCustomer(slug);
    const { memory, slack, searchMessages } = build();

    const [match] = (await memory.executeTool(
      "findCustomers",
      { query: slug },
      { executionId: "e1" }
    )) as { customerRef: string }[];
    expect(match.customerRef).toMatch(/^cust_/);

    await slack.executeTool(
      "searchMessages",
      { query: "checkout", customerRef: match.customerRef },
      { executionId: "e1" }
    );
    // The gateway got the SLUG the host vouched for, resolved from the
    // reference the other namespace minted.
    expect(searchMessages).toHaveBeenCalledWith("checkout", 20, slug);
  });

  it("builds the context once per execution, not once per namespace", async () => {
    const slug = `acme${crypto.randomUUID().slice(0, 6)}`;
    await seedCustomer(slug);
    const { built, contexts, memory, slack } = build();

    await memory.executeTool(
      "findCustomers",
      { query: slug },
      { executionId: "e1" }
    );
    await slack
      .executeTool("thread", undefined, { executionId: "e1" })
      .catch(() => {});

    expect(built.filter((id) => id === "e1")).toHaveLength(1);
    // And therefore one call budget: the 40-call ceiling is per execution,
    // not forty per namespace.
    const e1 = contexts[built.indexOf("e1")];
    expect(e1.execution.counter.used).toBe(2);
  });
});
