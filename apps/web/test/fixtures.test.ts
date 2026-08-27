import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `isDemo()` reads `process.env.NEXT_PUBLIC_DEMO`, which Next inlines at build
 * time. Under vitest it is a real lookup, so each case sets it and re-imports
 * the module graph — a top-level constant would be captured once and every
 * later case would read the first case's value.
 */
async function loadWith(demo: boolean) {
  vi.resetModules();
  if (demo) process.env.NEXT_PUBLIC_DEMO = "1";
  else delete process.env.NEXT_PUBLIC_DEMO;
  return {
    roster: await import("@/lib/api/roster"),
    runs: await import("@/lib/api/runs"),
    approvals: await import("@/lib/api/approvals"),
    chat: await import("@/lib/api/chat"),
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ runs: [] }),
    } as Response)
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_DEMO;
});

describe("the demo transport switch", () => {
  it("serves the roster from fixtures without touching the network", async () => {
    const { roster } = await loadWith(true);
    const result = await roster.getRoster();

    expect(fetchSpy).not.toHaveBeenCalled();
    // The witness that fixture data came back rather than an empty object.
    // Both speakers resolve to the one connected account, which is what the
    // deployed Worker returns too — see lib/fixtures/roster.ts.
    expect(result.speaker?.email).toBe("sayandeten@gmail.com");
    expect(result.githubSpeaker?.email).toBe("sayandeten@gmail.com");
  });

  it("calls the relative path when demo is off", async () => {
    const { roster } = await loadWith(false);
    await roster.getRoster();

    expect(fetchSpy).toHaveBeenCalledWith("/api/roster", expect.anything());
  });

  it("keeps a run's usage total as the decimal string the ledger returned", async () => {
    const { runs } = await loadWith(true);
    const total = await runs.getRunUsageTotal(
      "7b2d5a90-6e1f-4c33-a8d7-90f1b3e6c258"
    );

    // Not 0.9042 the number: a float here is a rounded invoice.
    expect(total).toBe("0.9042");
    expect(typeof total).toBe("string");
  });
});

describe("starting a run", () => {
  it("resolves to a linkable fixture run without touching the network in demo mode", async () => {
    const { chat, runs } = await loadWith(true);

    const started = await chat.startChatRun("what shipped this week?", "req-1");
    expect(fetchSpy).not.toHaveBeenCalled();

    // The id has to be one `/runs/:id` can then render, or the demo dead-ends
    // on a page with nothing on it.
    const run = await runs.getRun(started.id);
    expect(run.id).toBe(started.id);
  });

  it("posts firstMessage and clientRequestId to /api/runs when demo is off", async () => {
    const { chat } = await loadWith(false);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: "run-1" }),
    } as Response);

    await expect(chat.startChatRun("hello", "req-9")).resolves.toEqual({
      id: "run-1",
    });

    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runs");
    expect(JSON.parse(String(init.body))).toEqual({
      firstMessage: "hello",
      clientRequestId: "req-9",
    });
  });

  it("reads one run from /api/runs/:id when demo is off", async () => {
    const { runs } = await loadWith(false);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ run: { id: "run-1" } }),
    } as Response);

    await runs.getRun("run-1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/runs/run-1", expect.anything());
  });
});

describe("the demo roster is internally consistent with speaker selection", () => {
  it("makes the speaker the first in pool order who has connected Slack", async () => {
    const { roster } = await loadWith(true);
    const { pool, engineers, speaker } = await roster.getRoster();

    const connected = new Map(
      engineers.map((engineer) => [engineer.email, engineer])
    );
    const expected = pool.find((email) => connected.get(email)?.slack === true);

    expect(speaker?.email).toBe(expected);
  });

  it("makes the GitHub speaker the first in pool order who has connected GitHub", async () => {
    const { roster } = await loadWith(true);
    const { pool, engineers, githubSpeaker } = await roster.getRoster();

    const connected = new Map(
      engineers.map((engineer) => [engineer.email, engineer])
    );
    const expected = pool.find(
      (email) => connected.get(email)?.github === true
    );

    expect(githubSpeaker?.email).toBe(expected);
  });
});

describe("deciding a demo approval", () => {
  it("removes it from the open list and answers 409-shaped on a second decision", async () => {
    const { approvals } = await loadWith(true);

    const open = await approvals.getOpenApprovals();
    expect(open.length).toBeGreaterThan(0);
    const first = open[0]!;

    await expect(
      approvals.decide(first.id, { action: "approve" })
    ).resolves.toEqual({
      result: "decided",
      decision: "approved",
    });

    const remaining = await approvals.getOpenApprovals();
    expect(remaining.map((card) => card.id)).not.toContain(first.id);

    await expect(
      approvals.decide(first.id, { action: "approve" })
    ).resolves.toEqual({
      result: "already_decided",
      decision: "approved",
      decidedBy: null,
    });
  });
});
