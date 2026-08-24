import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { assertEffectPermitted } from "../src/capabilities/write-guard";
import { CapabilityError } from "../src/gateways/errors";
import type { RunScope } from "../src/gateways/scope";
import { createOrGetRun, createOrGetRunUnderPolicy } from "../src/run/repository";

/**
 * Storage is shared across tests AND files in this pool, so every case mints
 * its own channel id and run key. Nothing here may assume an empty table.
 */
function freshChannelId(): string {
  return `C${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

async function seedChannel(mode: "observe" | "live" | "internal"): Promise<string> {
  const channelId = freshChannelId();
  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, NULL, ?)",
  )
    .bind(channelId, `chan-${channelId}`, mode)
    .run();
  return channelId;
}

/**
 * A scope over a real `runs` row. `mustShadow` goes through
 * createOrGetRunUnderPolicy — the shadow flag is derived by the ratchet, it is
 * not a field of RunDescriptor.
 */
async function seedScope(options: {
  shadow: boolean;
  channelId?: string;
}): Promise<RunScope> {
  const threadTs = `${Math.floor(Date.now() / 1000)}.${crypto.randomUUID().slice(0, 6)}`;
  const descriptor = options.channelId
    ? {
        key: `slack:${options.channelId}:${threadTs}`,
        origin: "slack" as const,
        channelId: options.channelId,
        threadTs,
      }
    : {
        key: `chat:${crypto.randomUUID()}`,
        origin: "chat" as const,
        channelId: null,
        threadTs: null,
      };

  const run = options.shadow
    ? await createOrGetRunUnderPolicy(env.DB, descriptor, { mustShadow: true })
    : await createOrGetRun(env.DB, descriptor);

  return {
    runId: run.id,
    turnId: crypto.randomUUID(),
    origin: run.origin,
    shadow: run.shadow,
    customerSlug: null,
    slackThread:
      run.channelId && run.threadTs
        ? { channelId: run.channelId, threadTs: run.threadTs }
        : null,
    actor: { engineerEmail: "ronit@zellify.app", slackUserId: "U0RONIT" },
  };
}

const deps = { db: env.DB };

describe("write guard", () => {
  it("lets a read through on a shadow run", async () => {
    const scope = await seedScope({ shadow: true });
    await expect(assertEffectPermitted(deps, scope, "read")).resolves.toBeUndefined();
  });

  it("lets a control write and a sandbox write through on a shadow run", async () => {
    // Only `external_write` is gated. A shadow run must still be able to
    // escalate for approval and drive its own container — it just cannot
    // reach the outside world.
    const scope = await seedScope({ shadow: true });
    await expect(assertEffectPermitted(deps, scope, "control_write")).resolves.toBeUndefined();
    await expect(assertEffectPermitted(deps, scope, "sandbox_write")).resolves.toBeUndefined();
  });

  it("refuses an external write from a shadow run", async () => {
    const scope = await seedScope({ shadow: true });
    await expect(assertEffectPermitted(deps, scope, "external_write")).rejects.toMatchObject({
      code: "shadow_write_denied",
    });
  });

  it("permits an external write from a live channel", async () => {
    const channelId = await seedChannel("live");
    const scope = await seedScope({ shadow: false, channelId });
    await expect(assertEffectPermitted(deps, scope, "external_write")).resolves.toBeUndefined();
  });

  it("refuses an external write into an observe channel", async () => {
    const channelId = await seedChannel("observe");
    const scope = await seedScope({ shadow: false, channelId });
    await expect(assertEffectPermitted(deps, scope, "external_write")).rejects.toMatchObject({
      code: "channel_read_only",
    });
  });

  it("refuses an external write into a channel absent from the table", async () => {
    // Fail closed: an unmapped channel is never postable.
    const scope = await seedScope({ shadow: false, channelId: freshChannelId() });
    await expect(assertEffectPermitted(deps, scope, "external_write")).rejects.toMatchObject({
      code: "channel_read_only",
    });
  });

  it("refuses an external write on a slack-origin scope with no thread", async () => {
    const channelId = await seedChannel("live");
    const scope = await seedScope({ shadow: false, channelId });
    await expect(
      assertEffectPermitted(deps, { ...scope, slackThread: null }, "external_write"),
    ).rejects.toMatchObject({ code: "slack_context_required" });
  });

  it("refuses an external write when the run row cannot be confirmed", async () => {
    // An unconfirmable run is not a permitted one. This must REFUSE rather
    // than default shadow to false.
    const scope = await seedScope({ shadow: false });
    await expect(
      assertEffectPermitted(deps, { ...scope, runId: crypto.randomUUID() }, "external_write"),
    ).rejects.toMatchObject({ code: "shadow_write_denied" });
  });

  it("re-reads shadow at call time rather than trusting the scope snapshot", async () => {
    // scope.shadow is a diagnostic snapshot, deliberately not an authorization.
    // An operator flipping a run to shadow mid-run must stop the NEXT write.
    const scope = await seedScope({ shadow: false });
    await env.DB.prepare("UPDATE runs SET shadow = 1 WHERE id = ?").bind(scope.runId).run();
    await expect(
      assertEffectPermitted(deps, { ...scope, shadow: false }, "external_write"),
    ).rejects.toMatchObject({ code: "shadow_write_denied" });
  });

  it("throws CapabilityError, so a refusal serialises as `code: message`", async () => {
    const scope = await seedScope({ shadow: true });
    await expect(assertEffectPermitted(deps, scope, "external_write")).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });
});
