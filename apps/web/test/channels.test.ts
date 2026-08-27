import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The registry's one non-obvious rule: `slugSource` is not something the client
 * sets, it is a CONSEQUENCE of setting the slug. Confirming a guess promotes it
 * to `human`; clearing it sends the row back to `derived`, which turns the
 * Supabase refusal back on. A `mode`-only patch touches neither.
 *
 * Pinned against the fixture rather than the Worker, because the fixture is
 * what demo mode renders and a demo that got this backwards would teach an
 * operator the opposite of the rule.
 */
async function load(demo: boolean) {
  vi.resetModules();
  if (demo) process.env.NEXT_PUBLIC_DEMO = "1";
  else delete process.env.NEXT_PUBLIC_DEMO;
  return await import("@/lib/api/channels");
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ channels: [] }),
    } as Response)
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_DEMO;
});

describe("the channel registry in demo mode", () => {
  it("shows both states the panel exists to distinguish", async () => {
    const channels = await (await load(true)).getChannels();
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(channels.some((c) => c.slugSource === "human")).toBe(true);
    expect(channels.some((c) => c.slugSource === "derived")).toBe(true);
    // A null slug must be reachable too, or "no customer" is never rendered.
    expect(channels.some((c) => c.customerSlug === null)).toBe(true);
  });

  it("promotes a confirmed slug to human in the same write", async () => {
    const api = await load(true);
    const before = (await api.getChannels()).find(
      (c) => c.slugSource === "derived" && c.customerSlug !== null
    );
    expect(before).toBeDefined();

    const after = await api.patchChannel(before!.channelId, {
      customerSlug: "driftwear",
    });

    expect(after.customerSlug).toBe("driftwear");
    expect(after.slugSource).toBe("human");
  });

  it("sends a cleared slug back to derived, so the refusal comes back on", async () => {
    const api = await load(true);
    const confirmed = (await api.getChannels()).find(
      (c) => c.slugSource === "human"
    );
    expect(confirmed).toBeDefined();

    const after = await api.patchChannel(confirmed!.channelId, {
      customerSlug: null,
    });

    expect(after.customerSlug).toBeNull();
    expect(after.slugSource).toBe("derived");
  });

  it("leaves the slug and its provenance alone on a mode-only patch", async () => {
    const api = await load(true);
    const before = (await api.getChannels()).find(
      (c) => c.slugSource === "human"
    );
    expect(before).toBeDefined();

    const after = await api.patchChannel(before!.channelId, {
      mode: "observe",
    });

    expect(after.mode).toBe("observe");
    expect(after.customerSlug).toBe(before!.customerSlug);
    expect(after.slugSource).toBe("human");
  });
});

describe("the live transport", () => {
  it("reads the relative path", async () => {
    await (await load(false)).getChannels();
    expect(fetchSpy).toHaveBeenCalledWith("/api/channels", expect.anything());
  });

  it("PATCHes one channel by id, encoded", async () => {
    const api = await load(false);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ channelId: "C0X", slugSource: "human" }),
    } as Response);

    await api.patchChannel("C0X", { mode: "observe" });

    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/channels/C0X");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ mode: "observe" });
  });

  it("throws on a 422, because a bad slug is a failure and not an answer", async () => {
    const api = await load(false);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ code: "invalid_patch" }),
    } as Response);

    await expect(
      api.patchChannel("C0X", { customerSlug: "NOPE" })
    ).rejects.toThrow();
  });
});
