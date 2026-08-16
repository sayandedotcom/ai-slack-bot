import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { Env } from "../src/index";
import type { RunAgent } from "../src/run/agent";

/**
 * Two opaque provider blobs, shaped like what Fable actually returns for
 * extended thinking: a signed block whose text is omitted, and a redacted one.
 * Their exact bytes are the subject of this test, so they carry characters a
 * careless re-encode would change — `+`, `/`, `=` and a non-ASCII glyph that
 * only survives if nobody NFC-normalizes or re-escapes the payload.
 */
const SIGNATURE =
  "EqQBCkYIBRgCKkD9x+Vn/2Zq0w==.thinking.signature/for+continuation.café==";
const REDACTED_DATA = "EvwBCoYBGAIiQK+redacted/thinking+payload==";

/**
 * Readable thinking, deliberately planted.
 *
 * Invariant 18 is "no reasoning in RunEvents, D1 telemetry, logs, or Zep" — the
 * session store is where a model message legitimately lives, so asserting that
 * a string nobody wrote is absent from D1 would prove nothing. This is the
 * string that makes those assertions bite: it IS in the transcript, and it must
 * not be anywhere else.
 */
const REASONING_TEXT = "readable-chain-of-thought-8f2b1c";

function assistantMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      // The omitted-thinking block. `text` is empty and the whole content is
      // the provider's signature — this is the part that must go back to the
      // provider unchanged or the next request is rejected mid-incident.
      {
        type: "reasoning",
        text: "",
        providerMetadata: { anthropic: { signature: SIGNATURE } },
      },
      // The redacted variant, same contract.
      {
        type: "reasoning",
        text: "",
        providerMetadata: { anthropic: { redactedData: REDACTED_DATA } },
      },
      // A readable reasoning part, the invariant-18 fixture. Nothing downstream
      // of the session may carry it.
      { type: "reasoning", text: REASONING_TEXT },
      { type: "text", text: "Rolled the migration back on staging." },
    ],
  };
}

/**
 * Invariants 17 and 18 — the signed thinking block survives a persist/reload
 * round trip byte-identically, and no readable reasoning leaves the session.
 *
 * Why this test exists at all: Think sanitizes every message at the write
 * boundary (`_rowSafe` → `sanitizeMessage` from `agents/chat`), and that
 * sanitizer both rewrites `providerMetadata` and DROPS reasoning parts whose
 * text is empty. An omitted-thinking block is exactly a reasoning part whose
 * text is empty. If the drop rule ever stops making an exception for parts
 * that still carry provider metadata — or if the OpenAI-metadata strip is ever
 * generalised across providers — the signature disappears from storage. That
 * failure throws nothing, breaks no type, and shows up only as the provider
 * refusing the next continuation, mid-incident. This is the check that turns
 * it into a red test instead.
 *
 * The reload is a REAL one: the object is evicted between the write and the
 * read, so the message comes back from the Durable Object's SQLite rather than
 * from Think's live in-memory cache, and the raw stored row is compared too.
 */
describe("thinking-block passthrough", () => {
  it("round-trips a signed omitted-thinking block byte-identically, and leaks no reasoning", async () => {
    // A fresh key per case: pool storage is shared across tests and files.
    const key = `chat:${crypto.randomUUID()}`;
    const agent = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

    const messageId = `msg_${crypto.randomUUID()}`;
    const original = assistantMessage(messageId);

    // `addMessages` and NOT `runTurn`: it bypasses the turn queue by contract,
    // so it cannot deadlock, and it goes through the same `_rowSafe` write
    // boundary every persisted assistant message goes through.
    await agent.addMessages([original]);

    // Drop the instance. Everything read after this line came off disk.
    //
    // The second `getAgentByName` is not decoration: Think hydrates its message
    // cache in `onStart` ("transcript-hydration"), and a bare RPC against an
    // evicted object does not run it — `getMessages()` would answer `[]` from
    // an empty cache and this test would pass for the wrong reason. Measured
    // 2026-08-16 while writing it.
    await evictDurableObject(agent);
    const revived = await getAgentByName<Env, RunAgent>(env.RUN_AGENTS, key);

    // The cast names what the DO returns. `getMessages()` reads as `never`
    // through the stub's RPC type mapping (`UIMessage`'s data-part index
    // signature is not structurally serializable to the mapper), and `never`
    // would silently swallow every assertion below it.
    const messages = (await revived.getMessages()) as unknown as UIMessage[];
    const reloaded = messages.find((m) => m.id === messageId);
    expect(reloaded, "the assistant message did not survive the reload").toBeDefined();

    // Byte-identical, not merely "still has a signature". A sanitizer that
    // re-encoded the blob, trimmed it, or moved it under a different metadata
    // key would keep a plausible-looking signature and still break the
    // continuation.
    expect(reloaded).toEqual(original);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(original));

    // ...and the same again against the row the session actually stored, which
    // is what a fresh instance in production hydrates from.
    const stored = await runInDurableObject(revived, async (instance: RunAgent) =>
      instance.session.getMessage(messageId),
    );
    expect(JSON.stringify(stored)).toBe(JSON.stringify(original));

    // The two signed blocks came back with EMPTY text, which is the shape
    // invariant 17 names: empty text plus the opaque provider metadata. A
    // sanitizer that had folded the readable part into them, or dropped the
    // empty ones and left only the readable one, would fail here.
    const reasoningParts = (reloaded?.parts ?? []).filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(3);
    expect(reasoningParts.filter((p) => ((p as { text?: string }).text ?? "") === "")).toHaveLength(2);

    // The D1 projection is the surface a dashboard, an export or a memory
    // episode would read from. Drive it for this run and prove the reasoning
    // text is not in it — the projection carries a status, a sequence and token
    // counts by design, and this is the assertion that keeps it that way.
    const runId = `run_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
       VALUES (?, ?, 'chat', NULL, NULL, 'live', 0, 0, 0)`,
    )
      .bind(runId, key)
      .run();

    // A leaked-reasoning summary is the realistic shape of this bug: a helpful
    // change that "summarises the last step" and reads the reasoning part to do
    // it. The projection must carry what it is given and nothing derived from
    // the thinking blocks, so the assertion below is on the ROW, not the input.
    await revived.projectForTest({ seq: Date.now(), status: "live", summary: "Rolled back." });
    await revived.recordUsageForTest({
      stepId: `step_${crypto.randomUUID()}`,
      model: "claude-fable-5",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const projected = await env.DB.prepare(
      `SELECT * FROM runs WHERE id = ?`,
    )
      .bind(runId)
      .first<Record<string, unknown>>();
    const billed = await env.DB.prepare(
      `SELECT * FROM agent_model_calls WHERE run_id = ?`,
    )
      .bind(runId)
      .all<Record<string, unknown>>();

    // Both projections actually landed. Without this the three `not.toContain`
    // assertions below would pass against an empty row set — the exact way a
    // "nothing leaked" test quietly stops proving anything.
    expect(projected?.summary).toBe("Rolled back.");
    expect(billed.results).toHaveLength(1);

    const projectionText = JSON.stringify({ projected, billed: billed.results });
    expect(projectionText).not.toContain(REASONING_TEXT);
    expect(projectionText).not.toContain(SIGNATURE);
    expect(projectionText).not.toContain(REDACTED_DATA);

    // The memory outbox is the ONLY road to Zep — `src/memory/consumer.ts`
    // drains it and nothing else writes a graph — so an empty result for this
    // run is the whole "no reasoning in Zep" claim, checked rather than argued.
    const outbox = await env.DB.prepare(
      `SELECT count(*) AS n FROM agent_memory_outbox
        WHERE run_id = ? OR episode_json LIKE ? OR source_json LIKE ?`,
    )
      .bind(runId, `%${REASONING_TEXT}%`, `%${REASONING_TEXT}%`)
      .first<{ n: number }>();
    expect(outbox?.n).toBe(0);
  });
});
