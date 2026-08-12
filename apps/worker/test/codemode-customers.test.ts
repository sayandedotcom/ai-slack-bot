import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry, type CapabilityRegistry } from "../src/codemode/registry";
import { makeSlackGateway } from "../src/slack/gateway";
import type { CodeModeScope } from "../src/codemode/contracts";
import type { MemoryFact, MemoryStore } from "../src/memory/store";
import {
  fakeAuditSink,
  fakeDeps,
  slackScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * HOST-MEDIATED CUSTOMER DISCOVERY (invariants 35 and 36).
 *
 * Two rules pull in opposite directions and both have to hold at once:
 *
 *  - a Slack run is PINNED. Its customer is whatever the D1 policy for its
 *    channel says, and it can neither discover another one nor name one;
 *  - a Chat run has no ambient customer at all, so it needs a way to acquire
 *    one — without that way becoming a way for anybody to acquire any customer.
 *
 * The resolution is that the model never handles a customer identifier. It
 * handles an opaque reference, minted by the host from a row the host itself
 * read, valid for exactly one `run_code` execution. Every case below is an
 * attempt to get a customer's data through some other door.
 */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

/** Records which graph was searched. The whole point is WHICH, not what came back. */
function recordingStore(): MemoryStore & { graphs: string[] } {
  const graphs: string[] = [];
  return {
    graphs,
    async ensureGraph() {},
    async addEpisode() {
      return { episodeUuid: "ep_0" };
    },
    async addMessage() {
      return { episodeUuid: "ep_0" };
    },
    async search(graphId: string): Promise<MemoryFact[]> {
      graphs.push(graphId);
      return [];
    },
  };
}

async function seedCustomer(input: {
  slug: string;
  mode?: "observe" | "live" | "internal";
  name?: string;
}): Promise<string> {
  const channelId = `C${uid()}`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)",
  )
    .bind(channelId, input.name ?? `chan-${input.slug}`, input.slug, input.mode ?? "live")
    .run();
  return channelId;
}

type Harness = {
  registry: CapabilityRegistry;
  memory: ReturnType<typeof recordingStore>;
  scope: CodeModeScope;
};

/** One `run_code` execution's worth of capabilities. */
function execution(scope: CodeModeScope): Harness {
  const memory = recordingStore();
  const deps = {
    ...fakeDeps(),
    db: env.DB,
    memory,
    slack: makeSlackGateway(env.DB, scope),
  };
  return {
    registry: buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() })),
    memory,
    scope,
  };
}

const chatScope = (patch: Partial<CodeModeScope> = {}): CodeModeScope => ({
  ...slackScope,
  runId: `run_${crypto.randomUUID()}`,
  turnId: `turn_${crypto.randomUUID()}`,
  origin: "chat",
  customerSlug: null,
  slackThread: null,
  ...patch,
});

const call = (h: Harness, namespace: string, method: string, args: unknown) =>
  (
    h.registry.find((p) => p.name === namespace)!.tools[method] as {
      execute: (a: unknown) => Promise<unknown>;
    }
  ).execute(args);

type Match = { customerRef: string; label: string };

/* ------------------------------------------------------------- discovery -- */

describe("memory.findCustomers", () => {
  it("is refused in a Slack conversation, which is already scoped", async () => {
    const h = execution({ ...slackScope, origin: "slack" });
    await expect(call(h, "memory", "findCustomers", { query: "acme" })).rejects.toThrow(
      /capability_unavailable/,
    );
  });

  it("finds a customer by slug in an internal chat", async () => {
    const slug = `acme-${uid().toLowerCase()}`;
    await seedCustomer({ slug });

    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: slug,
    })) as Match[];

    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe(slug);
  });

  it("returns no graph id and no channel id", async () => {
    const slug = `globex-${uid().toLowerCase()}`;
    const channelId = await seedCustomer({ slug });

    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: slug,
    })) as Match[];

    // Exactly two fields, and neither of them is a destination or a graph
    // handle. A channel id here would be a reply target the model was never
    // meant to have; a graph id would be a memory read that skips the resolver.
    expect(Object.keys(matches[0]).sort()).toEqual(["customerRef", "label"]);
    expect(JSON.stringify(matches)).not.toContain(channelId);
    expect(JSON.stringify(matches)).not.toContain("customer:");
  });

  it("returns nothing for an unknown name rather than guessing", async () => {
    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: `nobody-${uid()}`,
    })) as Match[];
    expect(matches).toEqual([]);
  });

  it("returns every ambiguous match and picks none of them", async () => {
    const stem = `dup${uid().toLowerCase()}`;
    await seedCustomer({ slug: `${stem}-north` });
    await seedCustomer({ slug: `${stem}-south` });

    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: stem,
    })) as Match[];

    // Ambiguity is the model's to resolve by asking, not the host's to resolve
    // by guessing. Two references, two labels, no default.
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.customerRef)).size).toBe(2);
  });

  it("collapses one customer's many channels into one result", async () => {
    const slug = `multi-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    await seedCustomer({ slug });
    await seedCustomer({ slug });

    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: slug,
    })) as Match[];
    expect(matches).toHaveLength(1);
  });

  it("does not enumerate the catalog through a wildcard", async () => {
    await seedCustomer({ slug: `wild-${uid().toLowerCase()}` });
    // `%` is escaped before it reaches LIKE, so this searches for a literal
    // percent sign — a directory dump wearing a search's clothes is refused by
    // arithmetic rather than by hoping nobody tries.
    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: "%%",
    })) as Match[];
    expect(matches).toEqual([]);
  });

  it("caps results however large a limit is requested", async () => {
    const stem = `many${uid().toLowerCase()}`;
    for (let i = 0; i < 12; i += 1) await seedCustomer({ slug: `${stem}-${i}` });

    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: stem,
      limit: 10,
    })) as Match[];
    expect(matches.length).toBeLessThanOrEqual(10);

    // And the schema itself refuses to ask for more.
    await expect(
      call(execution(chatScope()), "memory", "findCustomers", { query: stem, limit: 500 }),
    ).rejects.toThrow(/invalid_input/);
  });

  it("excludes internal channels, which have no customer to find", async () => {
    const slug = `internalonly-${uid().toLowerCase()}`;
    await seedCustomer({ slug, mode: "internal" });
    const matches = (await call(execution(chatScope()), "memory", "findCustomers", {
      query: slug,
    })) as Match[];
    expect(matches).toEqual([]);
  });
});

/* ------------------------------------------------------- using a reference -- */

describe("a reference is the only accepted handle", () => {
  it("scopes recall to the customer it names", async () => {
    const slug = `scoped-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    const h = execution(chatScope());

    const [match] = (await call(h, "memory", "findCustomers", { query: slug })) as Match[];
    await call(h, "memory", "recall", {
      query: "anything",
      scope: "customer",
      customerRef: match.customerRef,
    });

    expect(h.memory.graphs).toEqual([`customer:${slug}`]);
  });

  it("scopes slack.searchMessages to the customer it names", async () => {
    const slug = `search-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    const h = execution(chatScope());

    const [match] = (await call(h, "memory", "findCustomers", { query: slug })) as Match[];
    // Resolves and reaches the real D1-backed search rather than refusing.
    await expect(
      call(h, "slack", "searchMessages", { query: "outage", customerRef: match.customerRef }),
    ).resolves.toEqual([]);
  });

  it("refuses a guessed reference", async () => {
    const h = execution(chatScope());
    for (const guess of ["cust_1", "acme", "customer:acme", crypto.randomUUID()]) {
      await expect(
        call(h, "memory", "recall", { query: "x", scope: "customer", customerRef: guess }),
      ).rejects.toThrow(/invalid_input/);
    }
    // Nothing was searched. A guess must not cost a graph read either.
    expect(h.memory.graphs).toEqual([]);
  });

  it("refuses a reference minted in a DIFFERENT execution", async () => {
    const slug = `crossexec-${uid().toLowerCase()}`;
    await seedCustomer({ slug });

    const a = execution(chatScope());
    const b = execution(chatScope());
    const [match] = (await call(a, "memory", "findCustomers", { query: slug })) as Match[];

    // The reference is real, current, and names a customer that genuinely
    // exists. It is still meaningless here, which is the whole design.
    await expect(
      call(b, "memory", "recall", { query: "x", scope: "customer", customerRef: match.customerRef }),
    ).rejects.toThrow(/invalid_input/);
    expect(b.memory.graphs).toEqual([]);
  });

  it("names neither the reference nor a slug when it refuses", async () => {
    const slug = `secret-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    const a = execution(chatScope());
    const b = execution(chatScope());
    const [match] = (await call(a, "memory", "findCustomers", { query: slug })) as Match[];

    const err = await call(b, "memory", "recall", {
      query: "x",
      scope: "customer",
      customerRef: match.customerRef,
    }).catch((e: unknown) => e as Error);

    // Confirming which of two guesses was closer is itself an oracle.
    expect((err as Error).message).not.toContain(match.customerRef);
    expect((err as Error).message).not.toContain(slug);
  });

  it("keeps two concurrent chat customers apart within one execution", async () => {
    const one = `alpha-${uid().toLowerCase()}`;
    const two = `beta-${uid().toLowerCase()}`;
    await seedCustomer({ slug: one });
    await seedCustomer({ slug: two });
    const h = execution(chatScope());

    const [a] = (await call(h, "memory", "findCustomers", { query: one })) as Match[];
    const [b] = (await call(h, "memory", "findCustomers", { query: two })) as Match[];
    expect(a.customerRef).not.toBe(b.customerRef);

    await call(h, "memory", "recall", { query: "x", scope: "customer", customerRef: a.customerRef });
    await call(h, "memory", "recall", { query: "x", scope: "customer", customerRef: b.customerRef });

    // Both usable, each resolving to its own customer. Comparing an internal
    // engineer's two customers in one program is legitimate; the references
    // being distinct and non-transferable is what makes it safe.
    expect(h.memory.graphs).toEqual([`customer:${one}`, `customer:${two}`]);
  });

  it("still refuses customer recall in a chat that has looked nothing up", async () => {
    const h = execution(chatScope());
    await expect(
      call(h, "memory", "recall", { query: "x", scope: "customer" }),
    ).rejects.toThrow(/customer_scope_required/);
  });

  it("leaves org memory reachable without any reference", async () => {
    const h = execution(chatScope());
    await call(h, "memory", "recall", { query: "runbook", scope: "org" });
    expect(h.memory.graphs).toEqual(["org"]);
  });

  it("refuses a reference against org scope rather than silently ignoring it", async () => {
    const slug = `orgmix-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    const h = execution(chatScope());
    const [match] = (await call(h, "memory", "findCustomers", { query: slug })) as Match[];

    await expect(
      call(h, "memory", "recall", { query: "x", scope: "org", customerRef: match.customerRef }),
    ).rejects.toThrow(/invalid_input/);
  });
});

/* ------------------------------------------------------ Slack stays pinned -- */

describe("a Slack run cannot be redirected to another customer", () => {
  it("refuses a customerRef on recall outright", async () => {
    const h = execution({ ...slackScope, origin: "slack", customerSlug: "acme" });
    await expect(
      call(h, "memory", "recall", { query: "x", scope: "customer", customerRef: "cust_anything" }),
    ).rejects.toThrow(/invalid_input/);
    // Refused, not ignored. An ignored override would leave the model believing
    // it had scoped the search and reasoning about the answer as if it had.
    expect(h.memory.graphs).toEqual([]);
  });

  it("refuses a customerRef on slack.searchMessages outright", async () => {
    const h = execution({ ...slackScope, origin: "slack", customerSlug: "acme" });
    await expect(
      call(h, "slack", "searchMessages", { query: "x", customerRef: "cust_anything" }),
    ).rejects.toThrow(/invalid_input/);
  });

  it("uses its own channel's customer and nothing else", async () => {
    const h = execution({ ...slackScope, origin: "slack", customerSlug: "acme" });
    await call(h, "memory", "recall", { query: "x", scope: "customer" });
    expect(h.memory.graphs).toEqual(["customer:acme"]);
  });

  it("cannot even discover another customer's existence", async () => {
    const slug = `hidden-${uid().toLowerCase()}`;
    await seedCustomer({ slug });
    const h = execution({ ...slackScope, origin: "slack", customerSlug: "acme" });
    await expect(call(h, "memory", "findCustomers", { query: slug })).rejects.toThrow(
      /capability_unavailable/,
    );
  });
});
