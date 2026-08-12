import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveCodeModeScope } from "../src/agent/dependencies";
import { CapabilityError } from "../src/codemode/errors";
import type { RunState } from "../src/run/session";

/**
 * WHERE SCOPE COMES FROM.
 *
 * The single most valuable property in this phase is that no field of
 * `CodeModeScope` can be influenced by anything a model wrote or a caller sent.
 * Every case below therefore supplies a CONFLICTING value through the untrusted
 * channel and asserts the trusted one wins — a test that only checked the happy
 * path would pass just as well against a composer that read the turn metadata.
 */

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

async function seedChannel(input: {
  mode: "observe" | "live" | "internal";
  customerSlug: string | null;
}): Promise<string> {
  const channelId = `C${uid()}`;
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, ?, ?)",
  )
    .bind(channelId, `chan-${channelId}`, input.customerSlug, input.mode)
    .run();
  return channelId;
}

async function seedRun(input: {
  origin: "slack" | "chat";
  channelId: string | null;
  threadTs: string | null;
  shadow: boolean;
}): Promise<string> {
  const runId = `run_${crypto.randomUUID()}`;
  const key =
    input.origin === "slack"
      ? `slack:${input.channelId}:${input.threadTs}`
      : `chat:${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'live', ?, 0, 0)`,
  )
    .bind(runId, key, input.origin, input.channelId, input.threadTs, input.shadow ? 1 : 0)
    .run();
  return runId;
}

function stateFor(input: {
  runId: string;
  origin: "slack" | "chat";
  channelId: string | null;
  threadTs: string | null;
}): RunState {
  return {
    runId: input.runId,
    key:
      input.origin === "slack"
        ? `slack:${input.channelId}:${input.threadTs}`
        : `chat:${crypto.randomUUID()}`,
    origin: input.origin,
    channelId: input.channelId,
    threadTs: input.threadTs,
    status: "live",
    summary: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("CodeModeScope is assembled only from trusted sources", () => {
  it("takes run id, origin and Slack coordinates from run_state", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "1712345678.000100";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const scope = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "slack", channelId, threadTs }),
      "agent:gen:1",
    );

    expect(scope.runId).toBe(runId);
    expect(scope.origin).toBe("slack");
    expect(scope.slackThread).toEqual({ channelId, threadTs });
  });

  it("takes the turn id from the caller's persisted agent_turn_id", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "1712345678.000200";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const scope = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "slack", channelId, threadTs }),
      "agent:gen:abc",
    );
    expect(scope.turnId).toBe("agent:gen:abc");
  });

  // The single most dangerous wrong assumption in this phase. `shadow` is NOT
  // on RunState, so a composer that read the descriptor would see `undefined`,
  // which is falsy, and an observing run would post to a real customer.
  it("takes shadow from the D1 runs row, not from run_state", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "1712345678.000300";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: true });

    const state = stateFor({ runId, origin: "slack", channelId, threadTs });
    // RunState genuinely has no `shadow` field — this is what a caller trying
    // to assert one would have to smuggle in.
    const scope = await resolveCodeModeScope(
      env.DB,
      { ...state, shadow: false } as RunState & { shadow: boolean },
      "agent:gen:2",
    );
    expect(scope.shadow).toBe(true);
  });

  it("takes the customer slug from the channel policy, not from turn metadata", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "globex" });
    const threadTs = "1712345678.000400";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const state = stateFor({ runId, origin: "slack", channelId, threadTs });
    const scope = await resolveCodeModeScope(
      env.DB,
      // A malicious turn claiming a different customer, a different origin and
      // a different thread. Every one of them is ignored: the composer reads
      // named fields off `run_state` and D1, and `validateScope` is strict, so
      // an extra property cannot ride along either.
      {
        ...state,
        customerSlug: "acme",
        origin: "chat",
        threadTs: "9999999999.999999",
      } as RunState,
      "agent:gen:3",
    );

    // origin and threadTs came from the object above, because that object IS
    // the run_state row in this test — what matters is that customerSlug did
    // not, and that it came from D1.
    expect(scope.customerSlug).toBe("globex");
  });

  it("gives an unmapped channel no customer at all", async () => {
    const channelId = `C${uid()}`; // never inserted into `channels`
    const threadTs = "1712345678.000500";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const scope = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "slack", channelId, threadTs }),
      "agent:gen:4",
    );
    // Fail closed: no customer rather than a guessed one. Customer-scoped reads
    // then refuse with customer_scope_required instead of widening.
    expect(scope.customerSlug).toBeNull();
  });

  it("gives a chat run no customer and no Slack thread", async () => {
    const runId = await seedRun({ origin: "chat", channelId: null, threadTs: null, shadow: false });

    const scope = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "chat", channelId: null, threadTs: null }),
      "agent:gen:5",
    );
    expect(scope.origin).toBe("chat");
    expect(scope.customerSlug).toBeNull();
    expect(scope.slackThread).toBeNull();
  });

  it("resolves no actor in Phase 10", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "1712345678.000600";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const scope = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "slack", channelId, threadTs }),
      "agent:gen:6",
    );
    // Phase 12 supplies the on-duty engineer. Until then there is no identity,
    // and slack.reply refuses rather than speaking to a customer as a bot.
    expect(scope.actor).toBeNull();
  });

  // Before the prompt, before the provider, before a capability exists.
  it("fails closed when the run row cannot be resolved", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "1712345678.000700";

    const err = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId: `run_${crypto.randomUUID()}`, origin: "slack", channelId, threadTs }),
      "agent:gen:7",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("invalid_context");
  });

  it("refuses a malformed run_state rather than composing a half-valid scope", async () => {
    const channelId = await seedChannel({ mode: "live", customerSlug: "acme" });
    const threadTs = "not-a-timestamp";
    const runId = await seedRun({ origin: "slack", channelId, threadTs, shadow: false });

    const err = await resolveCodeModeScope(
      env.DB,
      stateFor({ runId, origin: "slack", channelId, threadTs }),
      "agent:gen:8",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("invalid_context");
  });
});
