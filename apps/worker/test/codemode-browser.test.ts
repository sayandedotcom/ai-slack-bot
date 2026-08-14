import { describe, expect, it } from "vitest";
import type { CapabilityDependencies, RecordingStatus } from "../src/codemode/gateways";
import { CapabilityError } from "../src/codemode/errors";
import {
  buildRegistry,
  capabilityEffectOf,
  PHASE_09_NAMESPACES,
} from "../src/codemode/registry";
import { MAX_RECORDING_TIMEOUT_MS } from "../src/sandbox/record";
import {
  fakeAuditSink,
  fakeDeps,
  fakeSandboxGateway,
  slackScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * THE `browser` NAMESPACE — Phase 19 Task 4.
 *
 * NOTHING HERE TOUCHES A CONTAINER OR PLAYWRIGHT. Every case runs against a
 * STUBBED `SandboxGateway` — the same seam `test/helpers/codemode.ts` fakes
 * for every other namespace — because everything this file has to prove lives
 * in the binding: schema shape, the effect classification, the timeout
 * ceiling, and that a refusal or an unusual result the gateway hands back
 * (not ready yet, no browser on this machine) reaches the model unchanged
 * rather than being reworded or swallowed. The gateway's own readiness gate
 * and its real delegation to `record.ts` are `src/sandbox/gateway.ts`'s
 * proof, not this file's.
 */

type Sandbox = CapabilityDependencies["sandbox"];

function browserTools(overrides: Partial<Sandbox> = {}) {
  const deps: CapabilityDependencies = {
    ...fakeDeps(),
    sandbox: { ...fakeSandboxGateway(), ...overrides },
  };
  return buildRegistry(
    slackScope,
    deps,
    TEST_LIMITS,
    testExecution({ audit: fakeAuditSink() }),
  ).find((p) => p.name === "browser")!.tools;
}

type Tools = ReturnType<typeof browserTools>;

const call = (tools: Tools, method: string, args: unknown = {}): Promise<unknown> =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

const RUNNING: RecordingStatus = {
  state: "running",
  url: null,
  error: null,
  stdoutTail: "",
  durationMs: 0,
};

/* ------------------------------------------------------------- the effect -- */

describe("the browser namespace", () => {
  it("is appended to the end of the frozen namespace order, after sandbox", () => {
    expect(PHASE_09_NAMESPACES[PHASE_09_NAMESPACES.length - 1]).toBe("browser");
    expect(PHASE_09_NAMESPACES).toEqual([
      "slack",
      "memory",
      "linear",
      "supabase",
      "langsmith",
      "betterstack",
      "files",
      "approval",
      "sandbox",
      "browser",
    ]);
  });

  it("is the last provider the registry builds", () => {
    const names = buildRegistry(
      slackScope,
      { ...fakeDeps(), db: undefined as never },
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink() }),
    ).map((p) => p.name);
    expect(names[names.length - 1]).toBe("browser");
  });

  it("classifies both methods as sandbox_write", () => {
    const tools = browserTools();
    const table: Record<string, string | null> = {};
    for (const [method, tool] of Object.entries(tools)) {
      table[method] = capabilityEffectOf(tool);
    }
    expect(table).toEqual({
      record: "sandbox_write",
      checkRecording: "sandbox_write",
    });
  });

  it("declares exactly record and checkRecording", () => {
    expect(Object.keys(browserTools()).sort()).toEqual(["checkRecording", "record"]);
  });
});

/* ------------------------------------------------------ boot-gate refusal -- */

describe("a call before boot", () => {
  const notReady = () =>
    new CapabilityError(
      "sandbox_not_ready",
      "the container for this run is still provisioning (installing dependencies), so nothing was run on it. Call sandbox.boot() and check its state again on your next turn — boot is a poll, not a wait.",
    );

  it("refuses record with the same poll-again code sandbox uses, unreworded", async () => {
    const tools = browserTools({
      record: async () => {
        throw notReady();
      },
    });
    const error = await call(tools, "record", { script: "await page.goto('https://x');", label: "repro" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe("sandbox_not_ready");
    expect((error as CapabilityError).message).toMatch(/boot/i);
  });

  it("refuses checkRecording the same way", async () => {
    const tools = browserTools({
      checkRecording: async () => {
        throw notReady();
      },
    });
    await expect(call(tools, "checkRecording", { recordingId: "rec_1" })).rejects.toThrow(
      /sandbox_not_ready/,
    );
  });
});

/* --------------------------------------------------------- browserless run -- */

describe("a browserless machine", () => {
  it("surfaces the harness's named browser-unavailable result through checkRecording, not a generic failure", async () => {
    const tools = browserTools({
      checkRecording: async () => ({
        state: "failed",
        url: null,
        error:
          "browser-unavailable: this run's container never got a working Chromium install. Do not retry — report it rather than spawning another harness.",
        stdoutTail: "",
        durationMs: 0,
      }),
    });
    const out = (await call(tools, "checkRecording", { recordingId: "rec_2" })) as RecordingStatus;
    // A first-class RESULT, not a thrown error — the call succeeds and hands
    // the model something it can act on.
    expect(out.state).toBe("failed");
    expect(out.error).toMatch(/browser-unavailable/);
    expect(out.url).toBeNull();
  });

  it("does not reword or drop the browser-unavailable reason", async () => {
    const distinctive = "browser-unavailable: chromium never installed on this container.";
    const tools = browserTools({
      checkRecording: async () => ({
        state: "failed",
        url: null,
        error: distinctive,
        stdoutTail: "",
        durationMs: 0,
      }),
    });
    const out = (await call(tools, "checkRecording", { recordingId: "rec_3" })) as RecordingStatus;
    expect(out.error).toBe(distinctive);
  });
});

/* ---------------------------------------------------------------- polling -- */

describe("record and checkRecording", () => {
  it("returns a handle from record without blocking on the outcome", async () => {
    const tools = browserTools({
      record: async () => ({ recordingId: "rec_4" }),
    });
    await expect(
      call(tools, "record", { script: "await page.click('button');", label: "repro" }),
    ).resolves.toEqual({ recordingId: "rec_4" });
  });

  it("passes a running state straight through as a result, not an error", async () => {
    const tools = browserTools({ checkRecording: async () => RUNNING });
    await expect(call(tools, "checkRecording", { recordingId: "rec_5" })).resolves.toEqual(RUNNING);
  });

  it("passes label and script through to the gateway untouched", async () => {
    let seen: unknown;
    const tools = browserTools({
      record: async (input) => {
        seen = input;
        return { recordingId: "rec_6" };
      },
    });
    await call(tools, "record", { script: "await page.goto('https://x');", label: "checkout flow" });
    expect(seen).toEqual({ script: "await page.goto('https://x');", label: "checkout flow" });
  });
});

/* ---------------------------------------------------------- timeout bounds -- */

describe("record's timeout ceiling", () => {
  it("rejects a timeout above the ceiling rather than clamping it", async () => {
    let called = false;
    const tools = browserTools({
      record: async () => {
        called = true;
        return { recordingId: "rec_7" };
      },
    });
    const error = await call(tools, "record", {
      script: "await page.goto('https://x');",
      label: "repro",
      timeoutMs: MAX_RECORDING_TIMEOUT_MS + 1,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).message).toMatch(String(MAX_RECORDING_TIMEOUT_MS));
    // A clamp would have started the recording anyway — the case this rules out.
    expect(called).toBe(false);
  });

  it("accepts a timeout at the ceiling and passes it through", async () => {
    let seen: unknown;
    const tools = browserTools({
      record: async (input) => {
        seen = input;
        return { recordingId: "rec_8" };
      },
    });
    await call(tools, "record", {
      script: "await page.goto('https://x');",
      label: "repro",
      timeoutMs: MAX_RECORDING_TIMEOUT_MS,
    });
    expect((seen as { timeoutMs?: number }).timeoutMs).toBe(MAX_RECORDING_TIMEOUT_MS);
  });

  it("omits timeoutMs entirely when the caller does not supply one", async () => {
    let seen: unknown;
    const tools = browserTools({
      record: async (input) => {
        seen = input;
        return { recordingId: "rec_9" };
      },
    });
    await call(tools, "record", { script: "await page.goto('https://x');", label: "repro" });
    expect(seen).not.toHaveProperty("timeoutMs");
  });
});

/* ----------------------------------------------------------- input schema -- */

describe("input validation", () => {
  it("rejects an empty script", async () => {
    const tools = browserTools();
    await expect(call(tools, "record", { script: "", label: "repro" })).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("rejects an unrecognized field", async () => {
    const tools = browserTools();
    await expect(
      call(tools, "record", { script: "await page.goto('https://x');", label: "repro", url: "https://x" }),
    ).rejects.toThrow(/invalid_input/);
  });

  it("rejects a missing recordingId", async () => {
    const tools = browserTools();
    await expect(call(tools, "checkRecording", {})).rejects.toThrow(/invalid_input/);
  });
});
