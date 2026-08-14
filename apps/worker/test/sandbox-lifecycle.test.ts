import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { GIT_SENTINEL_HOST, MONOREPO_SLUG, PLACEHOLDER_CREDENTIAL } from "../src/sandbox/class";
import {
  makeSandboxLifecycle,
  sandboxIdFor,
  sweepSandboxes,
  type SandboxHandle,
} from "../src/sandbox/lifecycle";
import { createOrGetRun, setRunStatus } from "../src/run/repository";

/**
 * THE PER-RUN CONTAINER LIFECYCLE — Phase 18 Task 4.
 *
 * NOTHING HERE TOUCHES A CONTAINER. Every case runs against a fake sandbox
 * injected through the one seam `makeSandboxLifecycle` exposes for it, so the
 * whole file costs milliseconds and can assert things a live container cannot
 * be asked to prove — that provisioning was started EXACTLY once under
 * concurrency, that a failed provision is never retried, that a sweep survives
 * a container whose destroy throws.
 *
 * Two properties carry the file:
 *
 *  1. BOOT IS THE POLL. A Tier 1 execution has 20 s (`codemode/contracts.ts`)
 *     and provisioning the monorepo has not finished in that time since it was
 *     a monorepo. So `boot` starts a background process and reports on it, and
 *     the thing that makes that safe is that the process — not a flag in an
 *     isolate a crash forgets — IS the state.
 *  2. PORT 3000 IS THE SANDBOX'S OWN CONTROL SERVER. It is the spike's worst
 *     trap because it fails by SUCCEEDING: a readiness check against 3000
 *     returns true whether or not the model's dev server ever started. Both
 *     port-taking methods refuse it by name.
 */

const RUN_ID = "run-lifecycle-1";
const REPO_PATH = "/workspace/web2app-rebuild";

type Recorded = { method: string; args: unknown[] };

type ProcessState = {
  id: string;
  status: string;
  exitCode?: number;
  startTime: Date;
};

type FakeOptions = {
  /** The provision process the container already holds, if any. */
  process?: ProcessState | null;
  stdout?: string;
  /** Exit code every `exec` reports. */
  execExitCode?: number;
  tunnelUrl?: string;
  destroy?: () => Promise<void>;
};

type Fake = { handle: SandboxHandle; calls: Recorded[] };

function makeFakeSandbox(options: FakeOptions = {}): Fake {
  const calls: Recorded[] = [];
  let process = options.process ?? null;

  const handle: SandboxHandle = {
    async exec(command, execOptions) {
      calls.push({ method: "exec", args: [command, execOptions] });
      return { exitCode: options.execExitCode ?? 0, stdout: "", stderr: "" };
    },
    async killAllProcesses() {
      calls.push({ method: "killAllProcesses", args: [] });
      return 0;
    },
    async startProcess(command, processOptions) {
      calls.push({ method: "startProcess", args: [command, processOptions] });
      process = {
        id: processOptions?.processId ?? "generated",
        status: "running",
        startTime: new Date(),
      };
      return { id: process.id };
    },
    async getProcess(id) {
      calls.push({ method: "getProcess", args: [id] });
      return process && process.id === id ? process : null;
    },
    async getProcessLogs(id) {
      calls.push({ method: "getProcessLogs", args: [id] });
      return { stdout: options.stdout ?? "", stderr: "" };
    },
    async destroy() {
      calls.push({ method: "destroy", args: [] });
      if (options.destroy) await options.destroy();
    },
    tunnels: {
      async get(port) {
        calls.push({ method: "tunnels.get", args: [port] });
        return { url: options.tunnelUrl ?? "https://spike-listen-auto.trycloudflare.com" };
      },
    },
  };

  return { handle, calls };
}

/**
 * The pool binds `SANDBOX_DISABLED` because it has no container runtime (see
 * vitest.config.ts). This file opts back IN, exactly as `notify-nudge.test.ts`
 * opts back into the nudge fallback — safe here because every container in this
 * file is a fake.
 */
const SANDBOX_ENV = { ...env, SANDBOX_DISABLED: "" } as Env;

/** A lifecycle over one fake container, with sleeps collapsed to nothing. */
function lifecycleOver(fake: Fake) {
  return makeSandboxLifecycle(SANDBOX_ENV, {
    resolve: () => fake.handle,
    sleep: async () => {},
  });
}

function countOf(calls: Recorded[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

describe("sandbox id", () => {
  it("names the container after the run and nothing else", () => {
    expect(sandboxIdFor(RUN_ID)).toBe(`run:${RUN_ID}`);
  });
});

describe("boot", () => {
  it("returns provisioning immediately and starts provision.sh once", async () => {
    const fake = makeFakeSandbox();
    const status = await lifecycleOver(fake).boot(RUN_ID);

    expect(status.state).toBe("provisioning");
    expect(status.commit).toBeNull();
    expect(status.repoPath).toBe(REPO_PATH);
    expect(countOf(fake.calls, "startProcess")).toBe(1);
  });

  it("reaps orphaned processes before starting, and points the remote at the sentinel", async () => {
    const fake = makeFakeSandbox();
    await lifecycleOver(fake).boot(RUN_ID);

    const order = fake.calls.map((call) => call.method);
    expect(order.indexOf("killAllProcesses")).toBeLessThan(order.indexOf("startProcess"));

    // The remote reaches provision.sh as an environment value rather than a
    // separate `git remote set-url` exec, because a cold container has no
    // repository to configure — it clones. What matters is unchanged and is what
    // this asserts: the URL the container receives names the sentinel and
    // carries the PLACEHOLDER, never a real credential.
    const start = fake.calls.find((call) => call.method === "startProcess");
    expect(start).toBeDefined();
    const remote = String(
      (start?.args[1] as { env?: Record<string, string> } | undefined)?.env?.SANDBOX_GIT_REMOTE,
    );
    expect(remote).toContain(GIT_SENTINEL_HOST);
    expect(remote).toContain(MONOREPO_SLUG);
    expect(remote).toContain(PLACEHOLDER_CREDENTIAL);
  });

  it("is single-flight: a concurrent pair provisions exactly once", async () => {
    const fake = makeFakeSandbox();
    const lifecycle = lifecycleOver(fake);

    const [first, second] = await Promise.all([lifecycle.boot(RUN_ID), lifecycle.boot(RUN_ID)]);

    expect(first.state).toBe("provisioning");
    expect(second.state).toBe("provisioning");
    expect(countOf(fake.calls, "startProcess")).toBe(1);
  });

  it("reports the running step in the note while provisioning", async () => {
    const fake = makeFakeSandbox({
      process: { id: "provision", status: "running", startTime: new Date(Date.now() - 4_000) },
      stdout: "STEP fetch\nSTEP reset\nSTEP install\n",
    });

    const status = await lifecycleOver(fake).boot(RUN_ID);

    expect(status.state).toBe("provisioning");
    expect(status.note).toMatch(/install/i);
    expect(status.elapsedMs).toBeGreaterThanOrEqual(4_000);
    expect(countOf(fake.calls, "startProcess")).toBe(0);
  });

  it("reports ready with the commit once provision.sh exits 0", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const fake = makeFakeSandbox({
      process: {
        id: "provision",
        status: "completed",
        exitCode: 0,
        startTime: new Date(Date.now() - 30_000),
      },
      stdout: `STEP fetch\nSTEP reset\nSTEP install\nSTEP build-packages\nSTEP ready\n${commit}\n`,
    });

    const status = await lifecycleOver(fake).boot(RUN_ID);

    expect(status.state).toBe("ready");
    expect(status.commit).toBe(commit);
    expect(status.repoPath).toBe(REPO_PATH);
  });

  it("does no provisioning work once ready", async () => {
    const fake = makeFakeSandbox({
      process: {
        id: "provision",
        status: "completed",
        exitCode: 0,
        startTime: new Date(Date.now() - 30_000),
      },
      stdout: "STEP ready\n0123456789abcdef0123456789abcdef01234567\n",
    });
    const lifecycle = lifecycleOver(fake);

    await lifecycle.boot(RUN_ID);
    await lifecycle.boot(RUN_ID);

    expect(countOf(fake.calls, "startProcess")).toBe(0);
    expect(countOf(fake.calls, "killAllProcesses")).toBe(0);
  });

  it("names the failing step and does not retry a failed provision", async () => {
    const fake = makeFakeSandbox({
      process: {
        id: "provision",
        status: "failed",
        exitCode: 1,
        startTime: new Date(Date.now() - 12_000),
      },
      stdout: "STEP fetch\nSTEP reset\nSTEP install\nFAILED install\n",
    });
    const lifecycle = lifecycleOver(fake);

    const first = await lifecycle.boot(RUN_ID);
    const second = await lifecycle.boot(RUN_ID);

    expect(first.state).toBe("failed");
    expect(first.note).toContain("install");
    expect(second.state).toBe("failed");
    // The whole point: a failed provision is a verdict, not a retry loop.
    expect(countOf(fake.calls, "startProcess")).toBe(0);
  });
});

describe("teardown", () => {
  it("destroys, and destroying twice is not an error", async () => {
    const fake = makeFakeSandbox();
    const lifecycle = lifecycleOver(fake);

    await lifecycle.teardown(RUN_ID);
    await lifecycle.teardown(RUN_ID);

    expect(countOf(fake.calls, "destroy")).toBe(2);
  });

  it("is safe for a run that never booted", async () => {
    const fake = makeFakeSandbox();
    await expect(lifecycleOver(fake).teardown("run-that-never-booted")).resolves.toBeUndefined();
  });
});

describe("sweepSandboxes", () => {
  it("destroys terminal runs, leaves live ones alone, and survives a destroy that throws", async () => {
    const stamp = Date.now();
    const done = await createOrGetRun(env.DB, {
      key: `sweep-done-${stamp}`,
      origin: "slack",
      channelId: "C1",
      threadTs: "1.1",
    });
    const failed = await createOrGetRun(env.DB, {
      key: `sweep-failed-${stamp}`,
      origin: "slack",
      channelId: "C1",
      threadTs: "1.2",
    });
    const live = await createOrGetRun(env.DB, {
      key: `sweep-live-${stamp}`,
      origin: "slack",
      channelId: "C1",
      threadTs: "1.3",
    });
    await setRunStatus(env.DB, done.id, "done");
    await setRunStatus(env.DB, failed.id, "failed");
    await setRunStatus(env.DB, live.id, "live");

    const destroyed: string[] = [];
    const result = await sweepSandboxes(SANDBOX_ENV, {
      resolve: (_env, runId) =>
        makeFakeSandbox({
          destroy: async () => {
            destroyed.push(runId);
            // The bad container. One of these must not stop the sweep.
            if (runId === failed.id) throw new Error("containers control plane unreachable");
          },
        }).handle,
      sleep: async () => {},
    });

    expect(destroyed).toContain(done.id);
    expect(destroyed).toContain(failed.id);
    expect(destroyed).not.toContain(live.id);
    // The throwing one is attempted but not counted; the healthy one still is.
    // A shared test D1 holds other suites' terminal runs, so this is a floor.
    expect(result.destroyed).toBeGreaterThanOrEqual(1);
  });

  it("reaches no container at all where there is no container runtime", async () => {
    let resolved = 0;
    const result = await sweepSandboxes(env as Env, {
      resolve: () => {
        resolved += 1;
        return makeFakeSandbox().handle;
      },
    });

    // The pool's own env, opt-out intact. Not "destroys nothing" — never asks.
    expect(result.destroyed).toBe(0);
    expect(resolved).toBe(0);
  });
});

describe("waitForPort", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses port 3000 with the control-server trap named", async () => {
    const fake = makeFakeSandbox();
    await expect(lifecycleOver(fake).waitForPort(RUN_ID, 3000, 5_000)).rejects.toThrow(
      /control server/i,
    );
    expect(countOf(fake.calls, "exec")).toBe(0);
  });

  it("refuses ports outside 1024-65535", async () => {
    const lifecycle = lifecycleOver(makeFakeSandbox());
    await expect(lifecycle.waitForPort(RUN_ID, 80, 5_000)).rejects.toThrow(/1024/);
    await expect(lifecycle.waitForPort(RUN_ID, 70_000, 5_000)).rejects.toThrow(/65535/);
  });

  it("probes at the TCP level, not over HTTP", async () => {
    const fake = makeFakeSandbox({ execExitCode: 0 });
    const listening = await lifecycleOver(fake).waitForPort(RUN_ID, 4100, 5_000);

    expect(listening).toBe(true);
    const probe = String(fake.calls.find((call) => call.method === "exec")?.args[0]);
    expect(probe).toContain("/dev/tcp");
    expect(probe).toContain("4100");
  });

  it("reports not-listening rather than throwing when the probe times out", async () => {
    const fake = makeFakeSandbox({ execExitCode: 1 });
    await expect(lifecycleOver(fake).waitForPort(RUN_ID, 4100, 5_000)).resolves.toBe(false);
  });
});

describe("preview", () => {
  it("refuses port 3000 and out-of-range ports", async () => {
    const lifecycle = lifecycleOver(makeFakeSandbox());
    await expect(lifecycle.preview(RUN_ID, 3000)).rejects.toThrow(/control server/i);
    await expect(lifecycle.preview(RUN_ID, 80)).rejects.toThrow(/1024/);
  });

  it("keeps probing past a propagating tunnel's 530 instead of calling it dead", async () => {
    const url = "https://normally-listen-auto-geek.trycloudflare.com";
    const fake = makeFakeSandbox({ tunnelUrl: url });
    let probes = 0;
    vi.stubGlobal("fetch", async () => {
      probes += 1;
      return new Response(null, { status: probes < 3 ? 530 : 200 });
    });

    const preview = await lifecycleOver(fake).preview(RUN_ID, 4100);

    expect(preview.url).toBe(url);
    expect(probes).toBe(3);
    vi.unstubAllGlobals();
  });

  it("does not retry a 500 — an app that errors on its own config is still serving", async () => {
    const fake = makeFakeSandbox();
    let probes = 0;
    vi.stubGlobal("fetch", async () => {
      probes += 1;
      return new Response(null, { status: 500 });
    });

    await expect(lifecycleOver(fake).preview(RUN_ID, 4100)).resolves.toBeDefined();
    expect(probes).toBe(1);
    vi.unstubAllGlobals();
  });

  it("fails readably when the tunnel never propagates", async () => {
    const fake = makeFakeSandbox();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 530 }));

    await expect(lifecycleOver(fake).preview(RUN_ID, 4100)).rejects.toThrow(/530/);
    vi.unstubAllGlobals();
  });
});
