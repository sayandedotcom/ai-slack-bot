import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import type { CodeModeScope } from "../src/codemode/contracts";
import { CapabilityError } from "../src/codemode/errors";
import {
  assertClassified,
  buildRegistry,
  capabilityEffectOf,
  PHASE_09_NAMESPACES,
  type CapabilityRegistry,
} from "../src/codemode/registry";
import { assertEffectPermitted, CAPABILITY_EFFECTS } from "../src/codemode/write-guard";
import {
  EXEC_OUTPUT_CHARS,
  EXEC_TIMEOUT_CEILING_MS,
  PROCESS_TAIL_CHARS,
  READ_FILE_CHARS,
} from "../src/codemode/bindings/sandbox";
import { makeSandboxGateway, MIN_REDACTABLE_LENGTH } from "../src/sandbox/gateway";
import type { SandboxOpsHandle } from "../src/sandbox/gateway";
import {
  fakeAuditSink,
  fakeDeps,
  slackScope,
  TEST_LIMITS,
  testExecution,
} from "./helpers/codemode";

/**
 * THE `sandbox` NAMESPACE — Phase 18 Task 7.
 *
 * NOTHING HERE TOUCHES A CONTAINER. Every case runs against a fake container
 * handle injected through the one seam the gateway exposes, so the file costs
 * milliseconds and can assert the two things a live container is worst at
 * proving: that a dev-env VALUE cannot ride out on a result, and that a guard
 * refuses before any work is done rather than after.
 *
 * Three properties carry the file:
 *
 *  1. THE FOURTH EFFECT CLASS. `sandbox_write` mutates a machine this run owns
 *     and nobody else can see, so it passes the write guard in a shadow run and
 *     in an `observe` channel. That is the deliberate call — a shadow bug run
 *     that cannot reproduce produces a draft worth nothing — so it is asserted
 *     explicitly rather than left to the "everything but external_write passes"
 *     branch.
 *  2. REDACTION IS UNCONDITIONAL. `exec({ cmd: "env", injectDevEnv: true })`
 *     hands stdout straight to the model, and a dev server started by an
 *     earlier `spawn` can print its own environment from a later, unrelated
 *     `exec`. So every model-visible text field is scrubbed on every call, not
 *     only the ones that asked for dev env.
 *  3. THE GUARDS ARE READABLE. Port 3000, an over-long timeout and a call
 *     before `boot` each fail with a message the model can act on, and none of
 *     them silently clamps.
 */

const RUN_ID = "run_sandbox_ns";

/** Long enough to be redactable, and unmistakable in a JSON dump. */
const SENTINEL = "sk_dev_sentinel_7f3c9a11b2e4d6f8";
const SENTINEL_KEY = "SUPABASE_SECRET_API_KEY";

/**
 * A value BELOW the redaction floor, so the documented hole is a test rather
 * than a paragraph. `dev` is not hypothetical: `NEXT_PUBLIC_APP_ENV=dev` is the
 * shape half a dev-env blob has.
 */
const SHORT_VALUE = "dev";

const DEV_ENV = JSON.stringify({
  [SENTINEL_KEY]: SENTINEL,
  NEXT_PUBLIC_APP_ENV: SHORT_VALUE,
});

/** `STEP ready` plus a bare 40-hex line is what `provision.sh` prints on success. */
const READY_STDOUT = `STEP fetch\nSTEP install\nSTEP ready\n${"a".repeat(40)}\n`;

type ProcessState = {
  id: string;
  status: string;
  exitCode?: number;
  startTime: Date;
};

type Recorded = { method: string; args: unknown[] };

type FakeOptions = {
  /** Omit for a container that has never provisioned — the pre-`boot` case. */
  provisioned?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  fileContent?: string;
  processStatus?: string;
  processExitCode?: number;
  processStdout?: string;
  processStderr?: string;
  tunnelUrl?: string;
};

type Fake = { handle: SandboxOpsHandle; calls: Recorded[] };

function makeFakeSandbox(options: FakeOptions = {}): Fake {
  const calls: Recorded[] = [];
  const provision: ProcessState | null =
    options.provisioned === false
      ? null
      : { id: "provision", status: "completed", exitCode: 0, startTime: new Date() };
  const spawned = new Map<string, ProcessState>();

  // Declared as an overloaded FUNCTION rather than an object-literal method:
  // a single method-shorthand implementation is checked against each
  // overload's own return type and fails (a branch that can return
  // `{content: string}` does not satisfy the `{ encoding: "none" }` overload's
  // `Promise<{content: ReadableStream}>`). Real overload signatures plus one
  // wider implementation signature is the pattern TypeScript actually
  // supports, and it mirrors the real SDK exactly: `{ encoding: "none" }` is
  // the RPC raw-byte variant `readBinary` (Phase 19) calls; everything else is
  // the existing TEXT read every other case here exercises.
  function fakeReadFile(
    path: string,
    readFileOptions: { encoding: "none" },
  ): Promise<{ content: ReadableStream<Uint8Array> }>;
  function fakeReadFile(
    path: string,
    readFileOptions?: { encoding?: string },
  ): Promise<{ content: string }>;
  async function fakeReadFile(
    path: string,
    readFileOptions?: { encoding?: string },
  ): Promise<{ content: string } | { content: ReadableStream<Uint8Array> }> {
    calls.push({ method: "readFile", args: [path, readFileOptions] });
    if (readFileOptions?.encoding === "none") {
      const bytes = new TextEncoder().encode(options.fileContent ?? "");
      return {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    }
    return { content: options.fileContent ?? "" };
  }

  const handle: SandboxOpsHandle = {
    async exec(command, execOptions) {
      calls.push({ method: "exec", args: [command, execOptions] });
      return {
        exitCode: options.exitCode ?? 0,
        stdout: options.stdout ?? "",
        stderr: options.stderr ?? "",
      };
    },
    async killAllProcesses() {
      calls.push({ method: "killAllProcesses", args: [] });
      return 0;
    },
    async startProcess(command, processOptions) {
      calls.push({ method: "startProcess", args: [command, processOptions] });
      const id = processOptions?.processId ?? `proc_${spawned.size + 1}`;
      spawned.set(id, {
        id,
        status: options.processStatus ?? "running",
        exitCode: options.processExitCode,
        startTime: new Date(),
      });
      return { id };
    },
    async getProcess(id) {
      calls.push({ method: "getProcess", args: [id] });
      if (id === "provision") return provision;
      return spawned.get(id) ?? null;
    },
    async getProcessLogs(id) {
      calls.push({ method: "getProcessLogs", args: [id] });
      if (id === "provision") return { stdout: options.stdout ?? READY_STDOUT, stderr: "" };
      return {
        stdout: options.processStdout ?? "",
        stderr: options.processStderr ?? "",
      };
    },
    async killProcess(id, signal) {
      calls.push({ method: "killProcess", args: [id, signal] });
      spawned.delete(id);
    },
    readFile: fakeReadFile,
    async writeFile(path, content) {
      calls.push({ method: "writeFile", args: [path, content] });
      return { success: true };
    },
    async destroy() {
      calls.push({ method: "destroy", args: [] });
    },
    tunnels: {
      async get(port) {
        calls.push({ method: "tunnels.get", args: [port] });
        return { url: options.tunnelUrl ?? "https://fake-tunnel.trycloudflare.com" };
      },
    },
  };

  return { handle, calls };
}

/**
 * The pool binds `SANDBOX_DISABLED` because it has no container runtime. This
 * file opts back in — safe, because every container here is a fake — and
 * supplies the dev-env secret the redaction cases need.
 */
function sandboxEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, SANDBOX_DISABLED: "", MONOREPO_DEV_ENV: DEV_ENV, ...overrides } as Env;
}

/**
 * A registry whose `sandbox` gateway is the REAL one over a fake container.
 *
 * Deliberately not a fake gateway: redaction and the readiness gate live in the
 * gateway, and a double would assert them away rather than assert them.
 */
function sandboxTools(
  fake: Fake,
  options: { env?: Env; scope?: CodeModeScope; sleep?: (ms: number) => Promise<void> } = {},
) {
  const workerEnv = options.env ?? sandboxEnv();
  const deps = {
    ...fakeDeps(),
    db: env.DB,
    sandbox: makeSandboxGateway(workerEnv, RUN_ID, {
      resolve: () => fake.handle,
      sleep: options.sleep ?? (async () => {}),
    }),
  };
  return buildRegistry(
    options.scope ?? slackScope,
    deps,
    TEST_LIMITS,
    testExecution({ audit: fakeAuditSink() }),
  ).find((p) => p.name === "sandbox")!.tools;
}

type Tools = ReturnType<typeof sandboxTools>;

const call = (tools: Tools, method: string, args: unknown = {}): Promise<unknown> =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();

/** A run and a channel with exactly the policy the case is about. */
async function seedScope(input: {
  mode: "observe" | "live";
  shadow: boolean;
}): Promise<CodeModeScope> {
  const channelId = `C${uid()}`;
  const threadTs = "1712345678.000100";
  const runId = `run_${crypto.randomUUID()}`;

  await env.DB.prepare(
    "INSERT INTO channels (channel_id, name, customer_slug, mode) VALUES (?, ?, 'acme', ?)",
  )
    .bind(channelId, `chan-${channelId}`, input.mode)
    .run();
  await env.DB.prepare(
    `INSERT INTO runs (id, "key", origin, channel_id, thread_ts, status, shadow, created_at, updated_at)
     VALUES (?, ?, 'slack', ?, ?, 'live', ?, 0, 0)`,
  )
    .bind(runId, `slack:${channelId}:${threadTs}`, channelId, threadTs, input.shadow ? 1 : 0)
    .run();

  return {
    ...slackScope,
    runId,
    turnId: `turn_${crypto.randomUUID()}`,
    slackThread: { channelId, threadTs },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------ the effect class -- */

describe("the fourth effect class", () => {
  it("exists as its own class rather than being smuggled in as read", () => {
    expect(CAPABILITY_EFFECTS).toContain("sandbox_write");
    // `read` promises "changes nothing there", and `exec` plainly does.
    expect(CAPABILITY_EFFECTS).toEqual([
      "read",
      "external_write",
      "control_write",
      "sandbox_write",
    ]);
  });

  it("classifies every sandbox method as sandbox_write", () => {
    const tools = sandboxTools(makeFakeSandbox());
    const table: Record<string, string | null> = {};
    for (const [method, tool] of Object.entries(tools)) {
      table[method] = capabilityEffectOf(tool);
    }
    expect(table).toEqual({
      boot: "sandbox_write",
      exec: "sandbox_write",
      spawn: "sandbox_write",
      checkProcess: "sandbox_write",
      killProcess: "sandbox_write",
      readFile: "sandbox_write",
      writeFile: "sandbox_write",
      preview: "sandbox_write",
      diff: "sandbox_write",
    });
  });

  // THE DELIBERATE CALL, asserted rather than inherited. A shadow bug run that
  // cannot reproduce produces a draft worth nothing, and measuring the real
  // draft is the entire point of the shadow corpus.
  it("permits a sandbox_write in a shadow run", async () => {
    const scope = await seedScope({ mode: "live", shadow: true });
    await expect(
      assertEffectPermitted({ db: env.DB }, scope, "sandbox_write"),
    ).resolves.toBeUndefined();
    // The control: the same run, the same guard, an external write.
    await expect(
      assertEffectPermitted({ db: env.DB }, scope, "external_write"),
    ).rejects.toThrow(/shadow_write_denied/);
  });

  it("permits a sandbox_write in an observe channel", async () => {
    const scope = await seedScope({ mode: "observe", shadow: false });
    await expect(
      assertEffectPermitted({ db: env.DB }, scope, "sandbox_write"),
    ).resolves.toBeUndefined();
    await expect(
      assertEffectPermitted({ db: env.DB }, scope, "external_write"),
    ).rejects.toThrow(/channel_read_only/);
  });

  it("still refuses an unbranded descriptor claiming the new class", () => {
    const rogue: CapabilityRegistry = [
      {
        name: "rogue",
        tools: {
          runEverything: {
            effect: "sandbox_write",
            description: "a container write wearing a classification",
            execute: async () => ({}),
          } as never,
        },
      },
    ];
    expect(() => assertClassified(rogue)).toThrow(CapabilityError);
    expect(() => assertClassified(rogue)).toThrow(/auditedCapability/);
  });
});

/* --------------------------------------------------------- the namespace -- */

describe("the sandbox namespace", () => {
  // Phase 19 appends `browser` after this one, so `sandbox` is no longer the
  // LAST namespace — it is the ninth, immediately before the tenth. The
  // property this case actually guards (append-only, no reordering) is
  // unchanged: sandbox's own position in the frozen order is still fixed.
  it("is appended after approval, ninth in the frozen namespace order", () => {
    expect(PHASE_09_NAMESPACES.indexOf("sandbox")).toBe(PHASE_09_NAMESPACES.indexOf("approval") + 1);
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

  it("is the second-to-last provider the registry builds, right before browser", () => {
    const names = buildRegistry(
      slackScope,
      { ...fakeDeps(), db: env.DB },
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink() }),
    ).map((p) => p.name);
    expect(names[names.length - 1]).toBe("browser");
    expect(names[names.length - 2]).toBe("sandbox");
  });

  it("reports boot state without blocking on provisioning", async () => {
    const tools = sandboxTools(makeFakeSandbox());
    const status = (await call(tools, "boot")) as Record<string, unknown>;
    expect(status.state).toBe("ready");
    expect(status.commit).toBe("a".repeat(40));
  });

  it("spends the ~14s provisioning wait once per execution, not per call", async () => {
    // Both halves of this behaviour were paid for live. No wait at all starved
    // the step budget (run 317111cd died at its ceiling with a healthy machine
    // mid-install); a wait on EVERY call blew the 20s execution budget at 25.7s
    // when the model reasonably called boot twice in one block (run 29f027e4).
    // So: first boot in an execution long-polls, later ones answer instantly.
    const fake = makeFakeSandbox({ stdout: "STEP install\n" });
    // The fake's provision record is shared by reference, so flipping its
    // status is how the test scripts "mid-install, then finishes during the
    // long-poll's first sleep" without real time passing.
    const record = await fake.handle.getProcess("provision");
    if (!record) throw new Error("fake lost its provision record");
    record.status = "running";

    const sleeps: number[] = [];
    const tools = sandboxTools(fake, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        record.status = "completed";
      },
    });

    const first = (await call(tools, "boot")) as Record<string, unknown>;
    expect(first.state).toBe("ready");
    // Exactly one wait: the long-poll slept once, re-read, saw completion.
    expect(sleeps).toEqual([3_000]);

    record.status = "running";
    const second = (await call(tools, "boot")) as Record<string, unknown>;
    // Still provisioning AND no further sleeps: the execution's one wait is
    // spent, so the second call answered immediately instead of stacking
    // another ~14s onto a 20s budget.
    expect(second.state).toBe("provisioning");
    expect(sleeps).toEqual([3_000]);
  });
});

/* ------------------------------------------------------------- the guards -- */

describe("a call before boot", () => {
  const notProvisioned = () => makeFakeSandbox({ provisioned: false });

  it.each([
    ["exec", { cmd: "git log -1" }],
    ["readFile", { path: "/etc/hostname" }],
    ["diff", {}],
  ])("refuses %s with a code telling the model to boot first", async (method, args) => {
    const fake = notProvisioned();
    const tools = sandboxTools(fake);
    await expect(call(tools, method, args)).rejects.toThrow(/sandbox_not_ready/);
    await expect(call(tools, method, args)).rejects.toThrow(/boot/i);
  });

  it("does not run the command it refused", async () => {
    const fake = notProvisioned();
    await expect(call(sandboxTools(fake), "exec", { cmd: "rm -rf /" })).rejects.toThrow();
    expect(fake.calls.some((c) => c.method === "exec" && String(c.args[0]).includes("rm"))).toBe(
      false,
    );
  });
});

describe("port guards", () => {
  it("refuses port 3000 and names the trap", async () => {
    const tools = sandboxTools(makeFakeSandbox());
    const error = await call(tools, "preview", { port: 3000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    const message = (error as CapabilityError).message;
    expect(message).toMatch(/control server/i);
    expect(message).toMatch(/4100/);
  });

  it.each([[80], [1023], [65536], [0], [4100.5]])("refuses port %s", async (port) => {
    const tools = sandboxTools(makeFakeSandbox());
    await expect(call(tools, "preview", { port })).rejects.toThrow(/invalid_input/);
  });

  it("never asks the container for a refused port", async () => {
    const fake = makeFakeSandbox();
    await expect(call(sandboxTools(fake), "preview", { port: 3000 })).rejects.toThrow();
    expect(fake.calls.some((c) => c.method === "tunnels.get")).toBe(false);
  });

  it("accepts a port in the advised range", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const tools = sandboxTools(makeFakeSandbox());
    await expect(call(tools, "preview", { port: 4100 })).resolves.toEqual({
      url: "https://fake-tunnel.trycloudflare.com",
    });
  });
});

describe("exec bounds", () => {
  it("rejects a timeout above the ceiling rather than clamping it", async () => {
    const fake = makeFakeSandbox();
    const tools = sandboxTools(fake);
    const error = await call(tools, "exec", {
      cmd: "pnpm test",
      timeoutMs: EXEC_TIMEOUT_CEILING_MS + 1,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).message).toMatch(String(EXEC_TIMEOUT_CEILING_MS));
    // A clamp would have run the command anyway, which is the failure mode this
    // case exists to rule out: the model would believe it got its 60 seconds.
    expect(fake.calls.some((c) => c.method === "exec")).toBe(false);
    expect((error as CapabilityError).message).toMatch(/spawn/);
  });

  it("accepts a timeout at the ceiling and passes it to the container", async () => {
    const fake = makeFakeSandbox();
    await call(sandboxTools(fake), "exec", {
      cmd: "git status",
      timeoutMs: EXEC_TIMEOUT_CEILING_MS,
    });
    const execCall = fake.calls.find(
      (c) => c.method === "exec" && String(c.args[0]).includes("git status"),
    );
    expect((execCall?.args[1] as { timeout?: number } | undefined)?.timeout).toBe(
      EXEC_TIMEOUT_CEILING_MS,
    );
  });

  it("truncates stdout and stderr with a visible marker and an honest flag", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({
        stdout: "o".repeat(EXEC_OUTPUT_CHARS * 3),
        stderr: "e".repeat(EXEC_OUTPUT_CHARS * 3),
      }),
    );
    const out = (await call(tools, "exec", { cmd: "pnpm build" })) as {
      stdout: string;
      stderr: string;
      truncated: boolean;
    };

    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeLessThan(EXEC_OUTPUT_CHARS * 1.2);
    expect(out.stderr.length).toBeLessThan(EXEC_OUTPUT_CHARS * 1.2);
    expect(out.stdout).toMatch(/truncated/i);
    expect(out.stderr).toMatch(/truncated/i);
  });

  it("reports truncated: false when the output fits", async () => {
    const tools = sandboxTools(makeFakeSandbox({ stdout: "small\n" }));
    const out = (await call(tools, "exec", { cmd: "echo small" })) as {
      stdout: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(false);
    expect(out.stdout).toBe("small\n");
  });

  it("truncates readFile content with an honest flag", async () => {
    const tools = sandboxTools(makeFakeSandbox({ fileContent: "x".repeat(READ_FILE_CHARS * 2) }));
    const out = (await call(tools, "readFile", { path: "/etc/hosts" })) as {
      content: string;
      truncated: boolean;
    };
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(READ_FILE_CHARS * 1.2);
    expect(out.content).toMatch(/truncated/i);
  });

  it("tails a long-running process's logs rather than returning all of them", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({
        processStdout: "l".repeat(PROCESS_TAIL_CHARS * 3),
        processStderr: "w".repeat(PROCESS_TAIL_CHARS * 3),
      }),
    );
    const { processId } = (await call(tools, "spawn", { cmd: "pnpm test" })) as {
      processId: string;
    };
    const state = (await call(tools, "checkProcess", { processId })) as {
      running: boolean;
      stdoutTail: string;
      stderrTail: string;
    };
    expect(state.running).toBe(true);
    expect(state.stdoutTail.length).toBeLessThan(PROCESS_TAIL_CHARS * 1.2);
    expect(state.stderrTail.length).toBeLessThan(PROCESS_TAIL_CHARS * 1.2);
  });
});

/* ---------------------------------------------------------- the redaction -- */

describe("dev-env values never cross to the model", () => {
  /**
   * The whole result object, not one field. A value that survived into a nested
   * field, an error message or a key would still reach a run transcript, and
   * from there memory, and from there conceivably a customer-facing draft.
   */
  const clean = (result: unknown): void => {
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  };

  it("scrubs exec stdout and stderr", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({
        stdout: `${SENTINEL_KEY}=${SENTINEL}\nPATH=/usr/bin\n`,
        stderr: `warning: ${SENTINEL} is set\n`,
      }),
    );
    const out = (await call(tools, "exec", { cmd: "env", injectDevEnv: true })) as {
      stdout: string;
      stderr: string;
    };
    clean(out);
    expect(out.stdout).toContain(`[redacted:${SENTINEL_KEY}]`);
    expect(out.stderr).toContain(`[redacted:${SENTINEL_KEY}]`);
  });

  // A dev server started by an earlier spawn prints its own environment from a
  // LATER, unrelated exec. Redaction that only fired when the flag was set
  // would miss exactly that, which is the case that actually happens.
  it("scrubs an exec that never asked for dev env", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({ stdout: `leaked ${SENTINEL} from a process started earlier\n` }),
    );
    const out = (await call(tools, "exec", { cmd: "cat /proc/1/environ" })) as {
      stdout: string;
    };
    clean(out);
    expect(out.stdout).toContain(`[redacted:${SENTINEL_KEY}]`);
  });

  it("scrubs both process tails", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({
        processStdout: `ready with ${SENTINEL}\n`,
        processStderr: `failed using ${SENTINEL}\n`,
      }),
    );
    const { processId } = (await call(tools, "spawn", {
      cmd: "next dev --port 4100",
      injectDevEnv: true,
    })) as { processId: string };
    clean(await call(tools, "checkProcess", { processId }));
  });

  it("scrubs readFile content", async () => {
    const tools = sandboxTools(
      makeFakeSandbox({ fileContent: `${SENTINEL_KEY}=${SENTINEL}\n` }),
    );
    clean(await call(tools, "readFile", { path: "/tmp/.env" }));
  });

  it("scrubs the diff preview", async () => {
    const raw = [
      "diff --git a/app/page.tsx b/app/page.tsx",
      "--- a/app/page.tsx",
      "+++ b/app/page.tsx",
      "@@ -1 +1 @@",
      `+const key = "${SENTINEL}";`,
    ].join("\n");
    const tools = sandboxTools(makeFakeSandbox({ stdout: raw }));
    const result = (await call(tools, "diff")) as { preview: string; diffRef: string | null };
    clean(result);
    expect(result.diffRef).toMatch(/^diff_[0-9a-f]{64}$/);
  });

  // The hole, written down as a case rather than as a paragraph. A value short
  // enough to appear by coincidence in ordinary output cannot be replaced
  // without destroying the output it appears in.
  it("does not redact a value below the length floor", async () => {
    expect(SHORT_VALUE.length).toBeLessThan(MIN_REDACTABLE_LENGTH);
    const tools = sandboxTools(makeFakeSandbox({ stdout: "running in dev mode\n" }));
    const out = (await call(tools, "exec", { cmd: "echo" })) as { stdout: string };
    expect(out.stdout).toContain("dev mode");
  });
});

/* --------------------------------------------------------------- the diff -- */

describe("diff by reference", () => {
  it("returns a preview and a ref, never the bytes", async () => {
    const raw = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    const fake = makeFakeSandbox({ stdout: raw });
    const result = (await call(sandboxTools(fake), "diff")) as {
      preview: string;
      truncated: boolean;
      filesChanged: number;
      insertions: number;
      deletions: number;
      diffRef: string | null;
    };

    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.diffRef).toMatch(/^diff_[0-9a-f]{64}$/);
    // Intent-to-add, so a from-scratch file survives to the pull request.
    expect(fake.calls.some((c) => String(c.args[0]).includes("git add -A -N"))).toBe(true);
  });

  it("says so plainly when nothing changed", async () => {
    const result = (await call(sandboxTools(makeFakeSandbox({ stdout: "" })), "diff")) as {
      diffRef: string | null;
      preview: string;
    };
    expect(result.diffRef).toBeNull();
    expect(result.preview).toMatch(/no changes/i);
  });
});

/* ------------------------------------------------------ writes and kills -- */

describe("writeFile and killProcess", () => {
  it("reports the bytes it sent", async () => {
    const fake = makeFakeSandbox();
    const out = (await call(sandboxTools(fake), "writeFile", {
      path: "/tmp/a.ts",
      content: "const a = 1;\n",
    })) as { bytesWritten: number };
    expect(out.bytesWritten).toBe(13);
  });

  it("reports killed: false for a process that is not there", async () => {
    const tools = sandboxTools(makeFakeSandbox());
    await expect(call(tools, "killProcess", { processId: "nope" })).resolves.toEqual({
      killed: false,
    });
  });

  it("kills a process it started", async () => {
    const tools = sandboxTools(makeFakeSandbox());
    const { processId } = (await call(tools, "spawn", { cmd: "sleep 100" })) as {
      processId: string;
    };
    await expect(call(tools, "killProcess", { processId })).resolves.toEqual({ killed: true });
  });

  // Without autoCleanup:false the SDK drops the record on exit, so a finished
  // process reads as "never started" and the model can never learn its exit
  // code — the same trap `boot` had to solve.
  it("keeps a finished process readable", async () => {
    const fake = makeFakeSandbox();
    await call(sandboxTools(fake), "spawn", { cmd: "pnpm test" });
    const started = fake.calls.find((c) => c.method === "startProcess");
    expect((started?.args[1] as { autoCleanup?: boolean }).autoCleanup).toBe(false);
  });
});
