import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeMemoryTools } from "../src/capabilities/namespaces/memory";
import type { MemoryStore } from "../src/memory/store";
import { testBindingContext } from "./helpers/capabilities";

function memoryStore(facts: { factId: string; fact: string; episodeUuids?: string[] }[] = []): MemoryStore {
  return {
    ensureGraph: vi.fn(async () => {}),
    addEpisode: vi.fn(async () => ({ episodeUuid: "ep-1" })),
    addMessage: vi.fn(async () => ({ episodeUuid: "ep-1" })),
    // episodeUuids is required: recall maps over it to register provenance,
    // which is what makes an internal Chat answer cite customer evidence.
    search: vi.fn(async () => facts.map((f) => ({ episodeUuids: [], ...f }))),
  } as unknown as MemoryStore;
}

async function seedCustomer(slug: string): Promise<void> {
  const channelId = `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, 'live')",
  )
    .bind(channelId, slug, slug)
    .run();
}

describe("memory.findCustomers — invariant 36", () => {
  it("is refused on a Slack-origin run, which is already scoped", async () => {
    const ctx = testBindingContext({
      scope: { origin: "slack", customerSlug: "pulsefit" },
      deps: { memory: memoryStore() },
    });
    await expect(makeMemoryTools(ctx).findCustomers.run({ query: "pulse" })).rejects.toThrow();
  });

  it("returns opaque references, never raw slugs", async () => {
    const slug = `acme${crypto.randomUUID().slice(0, 6)}`;
    await seedCustomer(slug);
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: memoryStore() } });
    const out = (await makeMemoryTools(ctx).findCustomers.run({ query: slug })) as {
      customerRef: string;
      label: string;
    }[];
    expect(out.length).toBeGreaterThan(0);
    for (const row of out) expect(row.customerRef).not.toContain(slug);
  });

  it("mints a reference only for a row D1 actually returned", async () => {
    // The resolver only ever holds slugs this host read out of its own catalog.
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: memoryStore() } });
    const out = (await makeMemoryTools(ctx).findCustomers.run({
      query: "definitely-no-such-customer-xyz",
    })) as unknown[];
    expect(out).toEqual([]);
  });
});

describe("memory.recall — graph scoping", () => {
  it("never interpolates model input into a graph id", async () => {
    // A guessed slug is not a reference, so it cannot reach `customer:${…}`.
    const store = memoryStore();
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: store } });
    await expect(
      makeMemoryTools(ctx).recall.run({ query: "checkout", customerRef: "pulsefit" }),
    ).rejects.toThrow();
    expect(store.search).not.toHaveBeenCalled();
  });

  it("uses a reference minted in this execution", async () => {
    const slug = `acme${crypto.randomUUID().slice(0, 6)}`;
    await seedCustomer(slug);
    const store = memoryStore([{ factId: "f1", fact: "they use SSO" }]);
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: store } });
    const tools = makeMemoryTools(ctx);
    const [match] = (await tools.findCustomers.run({ query: slug })) as { customerRef: string }[];
    await tools.recall.run({ query: "sso", customerRef: match.customerRef });
    expect(store.search).toHaveBeenCalledWith(`customer:${slug}`, "sso", 10);
  });

  it("reads the org graph without any customer scope", async () => {
    const store = memoryStore();
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: store } });
    await makeMemoryTools(ctx).recall.run({ query: "deploys", scope: "org" });
    expect(store.search).toHaveBeenCalledWith("org", "deploys", 10);
  });

  it("refuses a customerRef alongside org scope", async () => {
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: memoryStore() } });
    await expect(
      makeMemoryTools(ctx).recall.run({ query: "x", scope: "org", customerRef: "cust_1" }),
    ).rejects.toThrow();
  });

  it("pins a Slack run to its own channel's customer", async () => {
    const store = memoryStore();
    const ctx = testBindingContext({
      scope: { origin: "slack", customerSlug: "pulsefit" },
      deps: { memory: store },
    });
    await makeMemoryTools(ctx).recall.run({ query: "checkout" });
    expect(store.search).toHaveBeenCalledWith("customer:pulsefit", "checkout", 10);
  });
});

describe("memory.cite", () => {
  it("accepts only fact ids recalled in this same execution", async () => {
    const ctx = testBindingContext({ scope: { origin: "chat" }, deps: { memory: memoryStore() } });
    await expect(makeMemoryTools(ctx).cite.run({ factIds: ["never-recalled"] })).rejects.toThrow();
  });
});
