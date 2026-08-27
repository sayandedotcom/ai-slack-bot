import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIREFIGHTERS } from "../src/access/roster";
import {
  type ApprovalSendResult,
  makeUserTokenSender,
} from "../src/approval/sender";
import { upsertIdentity } from "../src/db/identities";
import { importIdentityKey, SealError, seal } from "../src/identity/crypto";
import {
  makeUserTokenSource,
  type UserTokenSource,
} from "../src/identity/user-token";
import type { Env } from "../src/index";

/**
 * The credential path: whose token an approved reply goes out under, and what
 * this deployment is willing to claim about whether it landed.
 *
 * Two halves, tested separately. The SOURCE runs against real D1 and real
 * AES-GCM, with no clock: since 2026-08-17 there is no shift, and the speaker
 * is a connected fire-fighter chosen by roster order (or the approver, when
 * named and connected — `src/identity/speaker.ts`). Each case seeds rows for
 * roster members and asks who speaks. The SENDER never touches D1 at all; it
 * takes a stubbed source and a stubbed `fetch`, because the thing under test is
 * the mapping from a Slack response to an outcome a human will act on.
 */

function randomKeyB64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const IDENTITY_KEY = randomKeyB64();
const testEnv = { ...env, IDENTITY_KEY } as unknown as Env;

const TOKEN = "xoxp-user-token-do-not-leak";
/** Roster order is the tie-break, so "first" and "second" are the two facts that matter. */
const [FIRST_FF, SECOND_FF] = FIREFIGHTERS as [string, string, ...string[]];

/**
 * Leave the shared D1 as we found it — in an `afterEach`, not only a
 * `beforeEach`.
 *
 * This pool has no `isolatedStorage`, so an `identities` row seeded here
 * outlives the file, and a row for a connected fire-fighter is one of the two
 * things `sweepNudges` feeds on (see `test/notify-nudge.test.ts`'s note). Left
 * behind, it is one stale pending approval in some other suite away from
 * `worker.scheduled()` opening a REAL DM against slack.com with the pool's fake
 * bot token. Cleaning up on the way out is what keeps that unreachable.
 */
async function cleanIdentities(): Promise<void> {
  await env.DB.prepare("DELETE FROM identities").run();
}

beforeEach(cleanIdentities);
afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanIdentities();
});

async function seedSlack(
  email: string,
  patch: { token?: string; ciphertext?: string; externalId?: string } = {}
) {
  const key = await importIdentityKey(IDENTITY_KEY);
  await upsertIdentity(
    env.DB,
    {
      email,
      provider: "slack",
      externalId: patch.externalId ?? "U0SPEAKER",
      scopes: "chat:write",
      tokenCiphertext:
        patch.ciphertext ?? (await seal(key, patch.token ?? TOKEN)),
      connectedAt: 1000,
    },
    1000
  );
  return email;
}

describe("makeUserTokenSource", () => {
  it("returns the speaker's decrypted token and Slack user id", async () => {
    const email = await seedSlack(FIRST_FF, { externalId: "U0ONCALL" });

    expect(await makeUserTokenSource(testEnv).speakerToken()).toEqual({
      token: TOKEN,
      slackUserId: "U0ONCALL",
      email,
    });
  });

  it("returns null when no fire-fighter has a Slack row", async () => {
    expect(await makeUserTokenSource(testEnv).speakerToken()).toBeNull();
  });

  it("speaks as whoever HAS connected — roster order only breaks ties, it never blocks", async () => {
    // The old rotation returned null here: the seat belonged to someone else
    // for three days and a connected fire-fighter sat idle. Not any more.
    await seedSlack(SECOND_FF, {
      externalId: "U0SECOND",
      token: "xoxp-second",
    });
    expect(await makeUserTokenSource(testEnv).speakerToken()).toEqual({
      token: "xoxp-second",
      slackUserId: "U0SECOND",
      email: SECOND_FF,
    });

    await seedSlack(FIRST_FF, { externalId: "U0FIRST", token: "xoxp-first" });
    expect(await makeUserTokenSource(testEnv).speakerToken()).toMatchObject({
      email: FIRST_FF,
    });
  });

  it("speaks as the approver when they are a connected fire-fighter", async () => {
    await seedSlack(FIRST_FF, { externalId: "U0FIRST", token: "xoxp-first" });
    await seedSlack(SECOND_FF, {
      externalId: "U0SECOND",
      token: "xoxp-second",
    });
    expect(await makeUserTokenSource(testEnv).speakerToken(SECOND_FF)).toEqual({
      token: "xoxp-second",
      slackUserId: "U0SECOND",
      email: SECOND_FF,
    });
    // An approver who has not connected does not silence the reply.
    expect(
      await makeUserTokenSource(testEnv).speakerToken("nobody@zellify.app")
    ).toMatchObject({
      email: FIRST_FF,
    });
  });

  it("propagates a SealError on corrupt ciphertext instead of reporting not-connected", async () => {
    await seedSlack(FIRST_FF, { ciphertext: "not-a-sealed-value" });

    await expect(
      makeUserTokenSource(testEnv).speakerToken()
    ).rejects.toBeInstanceOf(SealError);
  });
});

/** A source that hands back a fixed credential, or nothing. */
function fixedSource(
  token: { token: string; slackUserId: string; email: string } | null
): UserTokenSource {
  return {
    async speakerToken() {
      return token;
    },
  };
}

const CREDENTIAL = {
  token: TOKEN,
  slackUserId: "U0ONCALL",
  email: "ronit@zellify.app",
};

type Sent = {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Headers;
};
let sent: Sent[] = [];

function stubSlack(respond: () => Response | Promise<Response>) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    return await respond();
  });
}

const INPUT = {
  runId: "run-1",
  channelId: "C0THREAD",
  threadTs: "1723600000.000100",
  text: "The export job hit the 30s worker timeout. We raised the limit; retry now.",
  decidedBy: null,
};

const send = (
  source: UserTokenSource = fixedSource(CREDENTIAL)
): Promise<ApprovalSendResult> => makeUserTokenSender(source).send(INPUT);

describe("makeUserTokenSender", () => {
  it("blocks without calling Slack when no fire-fighter has connected", async () => {
    stubSlack(() => new Response("{}", { status: 200 }));

    expect(await send(fixedSource(null))).toEqual({
      result: "blocked",
      reason: "no fire-fighter has connected Slack",
    });
    expect(sent).toEqual([]);
  });

  it("asks the source for the approver's token, so the human who clicked is the name on it", async () => {
    stubSlack(
      () =>
        new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 })
    );
    const asked: (string | null | undefined)[] = [];
    const source: UserTokenSource = {
      async speakerToken(preferred) {
        asked.push(preferred);
        return CREDENTIAL;
      },
    };

    await makeUserTokenSender(source).send({
      ...INPUT,
      decidedBy: "luka@zellify.app",
    });
    await makeUserTokenSender(source).send(INPUT);
    expect(asked).toEqual(["luka@zellify.app", null]);
  });

  it("sends under the user token and returns Slack's ts", async () => {
    stubSlack(
      () =>
        new Response(JSON.stringify({ ok: true, ts: "1723600123.000200" }), {
          status: 200,
        })
    );

    expect(await send()).toEqual({ result: "sent", ts: "1723600123.000200" });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent[0].body).toEqual({
      channel: INPUT.channelId,
      thread_ts: INPUT.threadTs,
      text: INPUT.text,
    });
    // Byte-exact: the approved draft is what a human signed off on.
    expect(sent[0].body.text).toBe(INPUT.text);
  });

  it("treats a definite Slack refusal as blocked, carrying Slack's own error", async () => {
    stubSlack(
      () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 200,
        })
    );

    expect(await send()).toEqual({ result: "blocked", reason: "invalid_auth" });
  });

  it("is in doubt when the request throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });

    expect(await send()).toEqual({
      result: "in_doubt",
      reason: "send attempted; outcome unknown",
    });
  });

  it("is in doubt on a non-JSON 200", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<html>proxy</html>", { status: 200 })
    );

    expect(await send()).toEqual({
      result: "in_doubt",
      reason: "send attempted; outcome unknown",
    });
  });

  it("uses an injected fetch rather than the global when given one", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("the global must not be used");
    });
    const calls: string[] = [];
    const injected = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    expect(
      await makeUserTokenSender(fixedSource(CREDENTIAL), injected).send(INPUT)
    ).toEqual({ result: "sent", ts: "1.2" });
    expect(calls).toEqual(["https://slack.com/api/chat.postMessage"]);
  });

  it("never puts token material in any outcome it returns", async () => {
    const outcomes: ApprovalSendResult[] = [];

    stubSlack(
      () =>
        new Response(JSON.stringify({ ok: true, ts: "1723600123.000200" }), {
          status: 200,
        })
    );
    outcomes.push(await send());

    // Slack echoing the token back in an error must not become a reason.
    stubSlack(
      () =>
        new Response(
          JSON.stringify({ ok: false, error: `invalid_auth ${TOKEN}` }),
          { status: 200 }
        )
    );
    outcomes.push(await send());

    vi.stubGlobal("fetch", async () => {
      throw new Error(`refused to connect with ${TOKEN}`);
    });
    outcomes.push(await send());

    vi.stubGlobal("fetch", async () => new Response(TOKEN, { status: 200 }));
    outcomes.push(await send());

    outcomes.push(await send(fixedSource(null)));

    expect(JSON.stringify(outcomes)).not.toContain(TOKEN);
    expect(outcomes.map((o) => o.result)).toEqual([
      "sent",
      "blocked",
      "in_doubt",
      "in_doubt",
      "blocked",
    ]);
  });
});
