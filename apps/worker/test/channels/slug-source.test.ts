/**
 * The tenant-key boundary, and the human surface that opens it.
 *
 * The property under test is narrow and worth stating plainly: a channel's
 * `customer_slug` is enough to pick a Zep graph the moment it exists, but it
 * may only be spent as a SUPABASE TENANT KEY once a human has confirmed it.
 * Auto-registration derives the slug from the Slack channel name, and a
 * derivation that happens to match a real tenant would return that tenant's
 * rows and look like a successful read.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";
import { registerChannel } from "../../src/channels/registry";
import { getChannelPolicy, isTenantKeyTrusted } from "../../src/db/channels";
import { CapabilityError } from "../../src/gateways/errors";
import { makeSupabaseReader } from "../../src/supabase/reader";
import { testScope } from "../helpers/capabilities";

function freshChannelId(): string {
  return `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/** The allowlist entry shape the reader consumes, with a tenant column set. */
const TENANT_CONFIG = {
  url: "https://example.supabase.co",
  key: "not-a-real-supabase-key",
  allowlist: [
    {
      resource: "orders",
      tenantColumn: "customer_slug",
      columns: [
        { name: "id", type: "text" },
        { name: "status", type: "text" },
      ],
    },
  ],
} as const;

/** Same, with NO tenant column — the control for "only tenant reads refuse". */
const UNSCOPED_CONFIG = {
  url: "https://example.supabase.co",
  key: "not-a-real-supabase-key",
  allowlist: [
    {
      resource: "status_page",
      tenantColumn: null,
      columns: [{ name: "id", type: "text" }],
    },
  ],
} as const;

function select(resource: string) {
  return {
    resource,
    columns: null,
    filters: [],
    order: null,
    limit: 10,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetIdentityApiPorts();
});

describe("isTenantKeyTrusted", () => {
  const base = {
    channel_id: "C1",
    name: "ext-acme",
    customer_slug: "acme",
    known: true,
  };

  it("trusts a slug a human confirmed", () => {
    expect(
      isTenantKeyTrusted({ ...base, mode: "live", slug_source: "human" })
    ).toBe(true);
  });

  it("refuses a slug derived from the channel name", () => {
    // The whole point. `#ext-acme` derives `acme`, which may or may not be
    // the tenant `acme` in someone else's database.
    expect(
      isTenantKeyTrusted({ ...base, mode: "live", slug_source: "derived" })
    ).toBe(false);
  });

  it("refuses when there is no slug at all, however confirmed", () => {
    expect(
      isTenantKeyTrusted({
        ...base,
        customer_slug: null,
        mode: "live",
        slug_source: "human",
      })
    ).toBe(false);
  });

  it("refuses an unknown channel", () => {
    expect(
      isTenantKeyTrusted({
        ...base,
        mode: "observe",
        slug_source: "human",
        known: false,
      })
    ).toBe(false);
  });
});

describe("auto-registration marks the slug derived", () => {
  it("never mints a trusted tenant key on its own", async () => {
    const id = freshChannelId();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("conversations.info")) {
        return Response.json({ ok: true, channel: { id, name: "ext-acme" } });
      }
      return Response.json({ ok: false, error: "not_stubbed" });
    });

    const policy = await registerChannel(env, id);

    expect(policy?.customer_slug).toBe("ext-acme");
    expect(policy?.slug_source).toBe("derived");
    expect(isTenantKeyTrusted(policy!)).toBe(false);
  });
});

describe("the supabase reader spends only a trusted slug", () => {
  it("refuses a tenant read when the slug was derived", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const reader = makeSupabaseReader(
      TENANT_CONFIG as never,
      testScope({ customerSlug: "acme", customerSlugTrusted: false })
    );

    await expect(reader.select(select("orders") as never)).rejects.toThrow(
      CapabilityError
    );
    await expect(
      reader.select(select("orders") as never)
    ).rejects.toMatchObject({ code: "customer_scope_unverified" });

    // The refusal is BEFORE the request. A read that reaches Supabase and is
    // filtered afterwards would already have sent the tenant value upstream.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("distinguishes 'no customer' from 'customer not confirmed'", async () => {
    // Two different codes because they ask for opposite reactions: one means
    // ask the customer who they are, the other means a human must confirm a
    // mapping on the dashboard.
    const reader = makeSupabaseReader(
      TENANT_CONFIG as never,
      testScope({ customerSlug: null, customerSlugTrusted: false })
    );
    await expect(
      reader.select(select("orders") as never)
    ).rejects.toMatchObject({ code: "customer_scope_required" });
  });

  it("lets a confirmed slug through, as the tenant predicate", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([]));
    const reader = makeSupabaseReader(
      TENANT_CONFIG as never,
      testScope({ customerSlug: "acme", customerSlugTrusted: true })
    );

    await reader.select(select("orders") as never);

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("customer_slug=eq.acme");
  });

  it("leaves a read with no tenant column alone", async () => {
    // The refusal must be narrow. An unscoped resource carries no tenant
    // boundary to violate, so a derived slug is irrelevant to it.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([]));
    const reader = makeSupabaseReader(
      UNSCOPED_CONFIG as never,
      testScope({ customerSlug: "acme", customerSlugTrusted: false })
    );

    await reader.select(select("status_page") as never);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain("customer_slug");
  });
});

describe("PATCH /api/channels/:id", () => {
  const FIREFIGHTER = "sayandeten@gmail.com";
  const VIEWER = "marcus@zellify.app";

  function asUser(email: string) {
    installIdentityApiPorts({
      verifier: {
        verify: async () => ({ email, sub: "s", aud: ["a"] }),
      } as never,
    });
  }

  async function seed(id: string, name: string) {
    await env.DB.prepare(
      "INSERT INTO channels (channel_id, name, customer_slug, mode, slug_source) VALUES (?, ?, ?, 'live', 'derived')"
    )
      .bind(id, name, name)
      .run();
  }

  function patch(id: string, body: unknown) {
    return SELF.fetch(`https://firefighter.example/api/channels/${id}`, {
      method: "PATCH",
      headers: {
        "Cf-Access-Jwt-Assertion": "stub",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("promotes the slug to human when a fire-fighter confirms it", async () => {
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);

    const res = await patch(id, { customerSlug: "acme-corp" });

    expect(res.status).toBe(200);
    const policy = await getChannelPolicy(env.DB, id);
    expect(policy.customer_slug).toBe("acme-corp");
    expect(policy.slug_source).toBe("human");
    expect(isTenantKeyTrusted(policy)).toBe(true);
  });

  it("demotes a channel without SQL", async () => {
    // The other half of the ask: taking back `live` used to mean writing SQL
    // against production D1.
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);

    const res = await patch(id, { mode: "observe" });

    expect(res.status).toBe(200);
    expect((await getChannelPolicy(env.DB, id)).mode).toBe("observe");
  });

  it("a mode-only patch does not touch slug provenance", async () => {
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);

    await patch(id, { mode: "internal" });

    expect((await getChannelPolicy(env.DB, id)).slug_source).toBe("derived");
  });

  it("clearing the slug sends provenance back to derived", async () => {
    // Nothing is confirmed any more, so the Supabase refusal must come back on.
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);
    await patch(id, { customerSlug: "acme-corp" });

    await patch(id, { customerSlug: null });

    const policy = await getChannelPolicy(env.DB, id);
    expect(policy.customer_slug).toBeNull();
    expect(policy.slug_source).toBe("derived");
    expect(isTenantKeyTrusted(policy)).toBe(false);
  });

  it("refuses a viewer, and writes nothing", async () => {
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(VIEWER);

    const res = await patch(id, { mode: "observe" });

    expect(res.status).toBe(403);
    expect((await getChannelPolicy(env.DB, id)).mode).toBe("live");
  });

  it("refuses a malformed slug", async () => {
    // It becomes a PostgREST query value and a Zep graph id; accepting
    // arbitrary text would mean trusting two encoders to be perfect forever.
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);

    for (const bad of ["Acme Corp", "acme/../etc", "eq.acme", "-acme", ""]) {
      const res = await patch(id, { customerSlug: bad });
      expect(res.status, `slug ${JSON.stringify(bad)}`).toBe(422);
    }
    expect((await getChannelPolicy(env.DB, id)).slug_source).toBe("derived");
  });

  it("refuses an empty patch and an unknown mode", async () => {
    const id = freshChannelId();
    await seed(id, "ext-acme");
    asUser(FIREFIGHTER);

    expect((await patch(id, {})).status).toBe(422);
    expect((await patch(id, { mode: "postable" })).status).toBe(422);
  });

  it("404s an unknown channel rather than creating one", async () => {
    // Not an upsert: registration derives the name from Slack, and inventing a
    // row here would mint a channel whose name nobody has confirmed exists.
    asUser(FIREFIGHTER);
    const id = freshChannelId();

    const res = await patch(id, { mode: "observe" });

    expect(res.status).toBe(404);
    expect((await getChannelPolicy(env.DB, id)).known).toBe(false);
  });
});
