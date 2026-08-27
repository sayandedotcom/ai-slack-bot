import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FIREFIGHTERS, VIEWERS } from "../src/access/roster";
import {
  getIdentity,
  listConnectStatus,
  upsertIdentity,
  type IdentityRow,
} from "../src/db/identities";

/**
 * Real D1 through the workerd vitest pool, no `isolatedStorage` (see
 * `vitest.config.ts`). D1 is shared across every suite in the pool, so each
 * case mints its own email and never assumes the table is empty — except the
 * `listConnectStatus` cases, which assert exact membership over the whole
 * table and therefore wipe it first.
 */

function email(): string {
  return `${crypto.randomUUID()}@example.test`;
}

function row(
  overrides: Partial<Omit<IdentityRow, "updatedAt">> = {}
): Omit<IdentityRow, "updatedAt"> {
  return {
    email: email(),
    provider: "slack",
    externalId: "U123",
    scopes: "chat:write,channels:history",
    tokenCiphertext: "sealed:v1:abcdef",
    connectedAt: 1000,
    ...overrides,
  };
}

describe("upsertIdentity / getIdentity", () => {
  it("round-trips a row", async () => {
    const r = row();
    await upsertIdentity(env.DB, r, 1500);

    expect(await getIdentity(env.DB, r.email, "slack")).toEqual({
      ...r,
      updatedAt: 1500,
    });
  });

  it("returns null for an unconnected (email, provider) pair", async () => {
    const r = row();
    await upsertIdentity(env.DB, r, 1500);

    // Same person, other provider: connected to Slack says nothing about GitHub.
    expect(await getIdentity(env.DB, r.email, "github")).toBeNull();
    expect(await getIdentity(env.DB, email(), "slack")).toBeNull();
  });

  it("overwrites token and updated_at on a second connect of the same pair", async () => {
    const r = row();
    await upsertIdentity(env.DB, r, 1500);

    await upsertIdentity(
      env.DB,
      {
        ...r,
        externalId: "U999",
        scopes: "chat:write",
        tokenCiphertext: "sealed:v1:rotated",
        connectedAt: 2000,
      },
      2500
    );

    expect(await getIdentity(env.DB, r.email, "slack")).toEqual({
      email: r.email,
      provider: "slack",
      externalId: "U999",
      scopes: "chat:write",
      tokenCiphertext: "sealed:v1:rotated",
      connectedAt: 2000,
      updatedAt: 2500,
    });

    // A re-connect must not leave a second row behind.
    const { results } = await env.DB.prepare(
      "SELECT email FROM identities WHERE email = ? AND provider = 'slack'"
    )
      .bind(r.email)
      .all();
    expect(results).toHaveLength(1);
  });

  it("keeps the two providers of one person independent", async () => {
    const e = email();
    await upsertIdentity(
      env.DB,
      row({ email: e, provider: "slack", tokenCiphertext: "s" }),
      100
    );
    await upsertIdentity(
      env.DB,
      row({ email: e, provider: "github", tokenCiphertext: "g" }),
      200
    );

    expect((await getIdentity(env.DB, e, "slack"))?.tokenCiphertext).toBe("s");
    expect((await getIdentity(env.DB, e, "github"))?.tokenCiphertext).toBe("g");
  });

  it("refuses an unknown provider at the database", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO identities (email, provider, external_id, scopes, token_ciphertext, connected_at, updated_at)
         VALUES (?, 'linear', 'x', 's', 'c', 1, 1)`
      )
        .bind(email())
        .run()
    ).rejects.toThrow();
  });
});

describe("listConnectStatus", () => {
  // Reads the whole table, so unique emails are not enough here.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM identities").run();
  });

  it("returns every roster email with its role and nothing connected", async () => {
    const status = await listConnectStatus(env.DB);

    expect(status).toHaveLength(FIREFIGHTERS.length + VIEWERS.length);
    expect(status.map((s) => s.email).sort()).toEqual(
      [...FIREFIGHTERS, ...VIEWERS].sort()
    );

    // The four fire-fighters plus the documented personal override.
    expect(
      status
        .filter((s) => s.role === "firefighter")
        .map((s) => s.email)
        .sort()
    ).toEqual([...FIREFIGHTERS].sort());
    expect(
      status
        .filter((s) => s.role === "viewer")
        .map((s) => s.email)
        .sort()
    ).toEqual([...VIEWERS].sort());
    expect(status.every((s) => s.slack === false && s.github === false)).toBe(
      true
    );
  });

  it("includes the personal override as a fire-fighter", async () => {
    const status = await listConnectStatus(env.DB);
    expect(status).toContainEqual({
      email: "sayandeten@gmail.com",
      role: "firefighter",
      slack: false,
      github: false,
    });
  });

  it("flips the slack and github booleans as identities are upserted", async () => {
    const e = FIREFIGHTERS[0]!;
    await upsertIdentity(env.DB, row({ email: e, provider: "slack" }), 100);

    let entry = (await listConnectStatus(env.DB)).find((s) => s.email === e);
    expect(entry).toEqual({
      email: e,
      role: "firefighter",
      slack: true,
      github: false,
    });

    await upsertIdentity(env.DB, row({ email: e, provider: "github" }), 200);
    entry = (await listConnectStatus(env.DB)).find((s) => s.email === e);
    expect(entry).toEqual({
      email: e,
      role: "firefighter",
      slack: true,
      github: true,
    });

    // Nobody else's status moved.
    const others = (await listConnectStatus(env.DB)).filter(
      (s) => s.email !== e
    );
    expect(others.every((s) => !s.slack && !s.github)).toBe(true);
  });

  it("ignores an identity row for an email that is not on the roster", async () => {
    await upsertIdentity(env.DB, row(), 100);

    const status = await listConnectStatus(env.DB);
    expect(status).toHaveLength(FIREFIGHTERS.length + VIEWERS.length);
    expect(status.every((s) => !s.slack && !s.github)).toBe(true);
  });

  it("never leaks a token into the connect status", async () => {
    await upsertIdentity(
      env.DB,
      row({
        email: FIREFIGHTERS[0]!,
        provider: "slack",
        tokenCiphertext: "sealed:v1:SECRET",
      }),
      100
    );

    const status = await listConnectStatus(env.DB);
    for (const entry of status) {
      expect(Object.keys(entry).sort()).toEqual([
        "email",
        "github",
        "role",
        "slack",
      ]);
      expect("tokenCiphertext" in entry).toBe(false);
    }
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });
});
