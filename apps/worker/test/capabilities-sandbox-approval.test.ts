/**
 * The three namespaces that act on this run's own machine or its own control
 * state: sandbox, browser and approval. None of them is `external_write`, so
 * none is gated by the write guard — a shadow run must still be able to
 * reproduce a bug and draft an escalation; it just never sends anything.
 */
import { describe, expect, it, vi } from "vitest";

import { makeApprovalTools } from "../src/capabilities/namespaces/approval";
import { makeBrowserTools } from "../src/capabilities/namespaces/browser";
import { makeSandboxTools } from "../src/capabilities/namespaces/sandbox";
import type { ApprovalPort } from "../src/approval/contracts";
import type { SandboxGateway } from "../src/gateways/ports";
import { testBindingContext } from "./helpers/capabilities";

function sandbox(overrides: Partial<SandboxGateway> = {}): SandboxGateway {
  return {
    boot: vi.fn(async () => ({ ready: true, phase: "ready" })),
    exec: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
    spawn: vi.fn(async () => ({ processId: "p1" })),
    checkProcess: vi.fn(async () => ({
      running: false,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    })),
    killProcess: vi.fn(async () => ({ killed: true })),
    readFile: vi.fn(async () => ({ content: "x" })),
    writeFile: vi.fn(async () => ({ bytesWritten: 1 })),
    preview: vi.fn(async () => ({ url: "https://preview.test" })),
    diff: vi.fn(async () => ({ diffRef: "d1", files: 1, insertions: 1, deletions: 0 })),
    readBinary: vi.fn(),
    record: vi.fn(async () => ({ recordingId: "r1" })),
    checkRecording: vi.fn(async () => ({
      state: "passed" as const,
      url: "https://proofs.test/r1",
      error: null,
      stdoutTail: "",
      durationMs: 10,
    })),
    ...overrides,
  } as unknown as SandboxGateway;
}

describe("sandbox", () => {
  it("addresses this run's machine — no method takes a container or run id", () => {
    const tools = makeSandboxTools(testBindingContext());
    for (const [method, tool] of Object.entries(tools)) {
      expect(JSON.stringify(tool.input), method).not.toMatch(/containerId|sandboxId|"runId"/);
    }
  });

  it("is classified sandbox_write, so a shadow run can still reproduce a bug", () => {
    const tools = makeSandboxTools(testBindingContext());
    for (const [method, tool] of Object.entries(tools)) {
      expect(tool.effect, method).toBe("sandbox_write");
    }
  });

  it("runs a command through the gateway", async () => {
    const gw = sandbox();
    const tools = makeSandboxTools(testBindingContext({ deps: { sandbox: gw } }));
    await tools.exec.run({ cmd: "pnpm test", timeoutMs: 1000, injectDevEnv: false });
    expect(gw.exec).toHaveBeenCalled();
  });
});

describe("browser", () => {
  it("takes Playwright source as a string, not a closure", () => {
    // A function cannot cross the isolate/container boundary.
    const tools = makeBrowserTools(testBindingContext());
    expect(JSON.stringify(tools.record.input)).toMatch(/script/);
  });

  it("returns a handle and polls, rather than blocking past the budget", async () => {
    const gw = sandbox();
    const tools = makeBrowserTools(testBindingContext({ deps: { sandbox: gw } }));
    const started = (await tools.record.run({
      script: "await page.goto('/')",
      label: "repro",
    })) as { recordingId: string };
    expect(started.recordingId).toBe("r1");
    const status = (await tools.checkRecording.run({ recordingId: "r1" })) as { url: string };
    expect(status.url).toBe("https://proofs.test/r1");
  });
});

describe("approval", () => {
  function port(overrides: Partial<ApprovalPort> = {}): ApprovalPort {
    return {
      open: vi.fn(async () => ({ approvalId: "apr:1" })),
      openApprovalId: vi.fn(() => null),
      withdraw: vi.fn(async () => ({ withdrawn: true as const })),
      ...overrides,
    };
  }

  it("opens an escalation and returns its id", async () => {
    const approval = port();
    const tools = makeApprovalTools(testBindingContext({ deps: { approval } }));
    const out = await tools.escalate.run({ draft: "we are on it", why: "commits us" });
    expect(out).toMatchObject({ approvalId: "apr:1" });
  });

  it("refuses a second open approval", async () => {
    // One open card per run: the D1 partial unique index enforces it too, but
    // refusing here gives the model a code it can read.
    const approval = port({ openApprovalId: vi.fn(() => "apr:1") });
    const tools = makeApprovalTools(testBindingContext({ deps: { approval } }));
    await expect(
      tools.escalate.run({ draft: "d", why: "w" }),
    ).rejects.toMatchObject({ code: "approval_already_open" });
  });

  it("refuses a withdraw when nothing is open", async () => {
    const tools = makeApprovalTools(testBindingContext({ deps: { approval: port() } }));
    await expect(tools.withdraw.run({})).rejects.toMatchObject({ code: "approval_not_open" });
  });

  it("returns the human's real decision when the human won the race", async () => {
    // The previous chassis stubbed this as a hardcoded "rejected" — it lied
    // about cards the human had approved.
    const approval = port({
      openApprovalId: vi.fn(() => "apr:1"),
      withdraw: vi.fn(async () => ({ withdrawn: false as const, decision: "approved" as const })),
    });
    const tools = makeApprovalTools(testBindingContext({ deps: { approval } }));
    await expect(tools.withdraw.run({})).resolves.toMatchObject({
      withdrawn: false,
      decision: "approved",
    });
  });

  it("is control_write, so a shadow run may still escalate", () => {
    const tools = makeApprovalTools(testBindingContext());
    for (const tool of Object.values(tools)) expect(tool.effect).toBe("control_write");
  });
});
