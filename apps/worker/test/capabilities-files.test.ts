import { describe, expect, it, vi } from "vitest";

import { makeFilesTools } from "../src/capabilities/namespaces/files";
import type { ArtifactPublisher } from "../src/gateways/ports";
import { createOrGetRun } from "../src/run/repository";
import { env } from "cloudflare:test";
import { testBindingContext } from "./helpers/capabilities";

async function liveChatScope() {
  const run = await createOrGetRun(env.DB, {
    key: `chat:${crypto.randomUUID()}`,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return { runId: run.id, origin: "chat" as const };
}

function publisher() {
  return {
    publish: vi.fn(async () => ({
      url: "https://artifacts.test/a",
      size: 3,
      sha256: "abc",
    })),
  } as unknown as ArtifactPublisher;
}

describe("files.publish", () => {
  it("publishes bytes and returns an address", async () => {
    const scope = await liveChatScope();
    const files = publisher();
    const ctx = testBindingContext({ scope, deps: { files } });
    const out = await makeFilesTools(ctx).publish.run({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      filename: "proof.png",
    });
    expect(out).toMatchObject({ url: "https://artifacts.test/a" });
  });

  it("publishes once for two identical calls in one turn", async () => {
    const scope = await liveChatScope();
    const files = publisher();
    const ctx = testBindingContext({ scope, deps: { files } });
    const tools = makeFilesTools(ctx);
    const args = {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      filename: "proof.png",
    };
    await tools.publish.run(args);
    await tools.publish.run({ ...args, bytes: new Uint8Array([1, 2, 3]) });
    expect(files.publish).toHaveBeenCalledTimes(1);
  });

  it("is classified external_write, so a shadow run cannot publish", async () => {
    const files = publisher();
    // No runs row at all: the guard fails closed before the gateway is reached.
    const ctx = testBindingContext({ deps: { files } });
    await expect(
      makeFilesTools(ctx).publish.run({
        bytes: new Uint8Array([1]),
        contentType: "text/plain",
        filename: "a.txt",
      })
    ).rejects.toMatchObject({ code: "shadow_write_denied" });
    expect(files.publish).not.toHaveBeenCalled();
  });

  it("keeps the binary out of the audit record", async () => {
    const scope = await liveChatScope();
    const events: import("../src/capabilities/audit").CapabilityEvent[] = [];
    const ctx = testBindingContext({
      scope,
      deps: { files: publisher() },
      events,
    });
    await makeFilesTools(ctx).publish.run({
      bytes: new Uint8Array(4096),
      contentType: "image/png",
      filename: "proof.png",
    });
    const started = events.find((e) => e.kind === "started");
    expect(started?.args).toMatchObject({ bytes: "<binary: 4096 bytes>" });
  });
});
