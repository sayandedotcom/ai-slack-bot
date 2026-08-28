import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessIdentity,
  AccessJwtError,
  type AccessVerifier,
} from "../../src/access/jwt";
import {
  installIdentityApiPorts,
  resetIdentityApiPorts,
} from "../../src/api/identity";

function fakeVerifier(): AccessVerifier {
  return {
    async verify(jwt: string): Promise<AccessIdentity> {
      if (!jwt) throw new AccessJwtError("missing", "no token was supplied");
      return { email: jwt };
    },
  };
}

beforeEach(() => {
  resetIdentityApiPorts();
  installIdentityApiPorts({ verifier: fakeVerifier() });
});
afterEach(() => resetIdentityApiPorts());

describe("POST /api/backfill/memory", () => {
  it("is a write, so it takes the roster gate like every other one", async () => {
    const anon = await SELF.fetch(
      "https://firefighter.test/api/backfill/memory",
      { method: "POST" }
    );
    expect(anon.status).toBe(401);
    const outsider = await SELF.fetch(
      "https://firefighter.test/api/backfill/memory",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": "someone@example.com" },
      }
    );
    expect(outsider.status).toBe(403);
    const member = await SELF.fetch(
      "https://firefighter.test/api/backfill/memory",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": "ronit@zellify.app" },
      }
    );
    expect(member.status).toBe(200);
    expect(typeof (await member.json<{ enqueued: number }>()).enqueued).toBe(
      "number"
    );
  });
});
