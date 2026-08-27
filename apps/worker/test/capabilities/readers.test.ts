/**
 * The three read-only vendor namespaces. All are `effect: "read"`, so none of
 * them touches the effect ledger and none is gated by the write guard — which
 * makes their scoping the thing worth pinning.
 */
import { describe, expect, it, vi } from "vitest";

import { makeBetterStackTools } from "../../src/capabilities/namespaces/betterstack";
import { makeLangSmithTools } from "../../src/capabilities/namespaces/langsmith";
import { makeSupabaseTools } from "../../src/capabilities/namespaces/supabase";
import type {
  BetterStackReader,
  LangSmithReader,
  SupabaseReader,
} from "../../src/gateways/ports";
import { testBindingContext } from "../helpers/capabilities";

describe("supabase", () => {
  it("passes structured filters through, never free text", () => {
    // A `query` string would be an injection surface into prod data.
    const rendered = JSON.stringify(
      makeSupabaseTools(testBindingContext()).select.input
    );
    expect(rendered).not.toMatch(/"sql"|"rawQuery"|"where"/);
  });

  it("reads rows through the reader", async () => {
    const supabase = {
      describe: vi.fn(async () => []),
      select: vi.fn(async () => [{ id: 1 }]),
    } as unknown as SupabaseReader;
    const tools = makeSupabaseTools(testBindingContext({ deps: { supabase } }));
    await expect(
      tools.select.run({ resource: "users", limit: 5 })
    ).resolves.toEqual([{ id: 1 }]);
  });

  it("refuses an unknown filter operator before querying", async () => {
    const supabase = {
      describe: vi.fn(async () => []),
      select: vi.fn(async () => []),
    } as unknown as SupabaseReader;
    const tools = makeSupabaseTools(testBindingContext({ deps: { supabase } }));
    await expect(
      tools.select.run({
        resource: "users",
        filters: [{ column: "id", op: "DROP", value: 1 }],
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(supabase.select).not.toHaveBeenCalled();
  });
});

describe("langsmith", () => {
  it("takes no project argument — the read pin is server-side", () => {
    // Repointing the pin at the live zellify-prod project in the same
    // workspace would let the agent surface real customer traffic into a
    // Slack reply.
    const tools = makeLangSmithTools(testBindingContext());
    for (const tool of Object.values(tools)) {
      expect(JSON.stringify(tool.input)).not.toMatch(/project|workspace/i);
    }
  });

  it("reads a trace by id", async () => {
    const langsmith = {
      trace: vi.fn(async () => ({ traceId: "t1", root: null, nodes: [] })),
      searchTraces: vi.fn(async () => []),
    } as unknown as LangSmithReader;
    const tools = makeLangSmithTools(
      testBindingContext({ deps: { langsmith } })
    );
    await tools.trace.run({ traceId: "t1" });
    expect(langsmith.trace).toHaveBeenCalledWith("t1");
  });

  it("names its search `searchTraces`, not `search`", () => {
    // Generated type aliases carry no namespace prefix, so a second `search`
    // would emit a duplicate `type SearchInput` and the joined declarations
    // would not compile.
    const tools = makeLangSmithTools(testBindingContext());
    expect(Object.keys(tools)).toContain("searchTraces");
    expect(Object.keys(tools)).not.toContain("search");
  });
});

describe("betterstack", () => {
  it("reads logs through the reader", async () => {
    const betterstack = {
      logs: vi.fn(async () => [
        { at: "2026-08-24T00:00:00Z", level: "error", message: "boom" },
      ]),
      monitors: vi.fn(async () => []),
    } as unknown as BetterStackReader;
    const tools = makeBetterStackTools(
      testBindingContext({ deps: { betterstack } })
    );
    const out = (await tools.logs.run({
      query: "boom",
      since: "1h",
    })) as unknown[];
    expect(out).toHaveLength(1);
  });

  it("takes no source id argument — the sources are pinned", () => {
    const rendered = JSON.stringify(
      makeBetterStackTools(testBindingContext()).logs.input
    );
    expect(rendered).not.toMatch(/sourceId|source_ids/i);
  });
});

describe("every reader is classified read", () => {
  it("means none of them is gated by the write guard", () => {
    const ctx = testBindingContext();
    const all = {
      ...makeSupabaseTools(ctx),
      ...makeLangSmithTools(ctx),
      ...makeBetterStackTools(ctx),
    };
    for (const [method, tool] of Object.entries(all)) {
      expect(tool.effect, method).toBe("read");
    }
  });
});
