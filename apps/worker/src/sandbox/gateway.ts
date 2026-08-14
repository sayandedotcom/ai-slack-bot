/**
 * Phase 18 Task 7 — the container, as the capability layer is allowed to see it.
 *
 * This is the seam between two halves that must not touch. Below it,
 * `lifecycle.ts`, `env.ts` and `diff.ts` hold the Worker `env`: a read PAT, the
 * dev-env secret, an R2 bucket. Above it, `codemode/bindings/sandbox.ts` holds
 * the model. Everything that must happen exactly once and Worker-side happens
 * here — dev-env injection, and the scrub that keeps its values from riding out
 * on a result — so the binding above can be nothing but schemas, bounds and
 * readable refusals.
 *
 * WHAT THE SCRUB IS AND IS NOT. Read `env.ts`'s header first: per-process
 * injection is a reduction in blast radius, not a boundary. Model-authored code
 * can ask a process to print its own environment, and `exec` hands stdout
 * straight back. So every text field that crosses this seam is scrubbed of
 * every known dev-env value, on every call, whether or not that call asked for
 * dev env — a dev server started by an earlier `spawn` will happily print its
 * environment from a later, unrelated `exec`.
 *
 * This DEFEATS THE ACCIDENTAL CASE, which is the one that actually happens: a
 * value landing in a run transcript, then in a memory episode, then conceivably
 * in a customer-facing draft. It is NOT airtight against a model that
 * deliberately encodes a value before printing it — `base64` and `rev` are both
 * in the image — and it does not fire below `MIN_REDACTABLE_LENGTH`. Neither
 * gap is closable from this side of the container, and both are written down
 * rather than claimed away.
 */
import type {
  SandboxCommandResult,
  SandboxGateway,
  SandboxProcessState,
} from "../codemode/gateways";
import { CapabilityError } from "../codemode/errors";
import type { Env } from "../index";
import { captureDiff, type DiffResult } from "./diff";
import { devEnvFor, devEnvForProcess } from "./env";
import {
  makeSandboxLifecycle,
  sandboxIdFor,
  type ProcessSnapshot,
  type SandboxLifecycleDeps,
} from "./lifecycle";
import { getSandbox } from "@cloudflare/sandbox";

/**
 * Everything this module and the lifecycle together ask of a container.
 *
 * Written structurally, and checked against the real class in `defaultResolve`
 * below, for the same reason `SandboxHandle` is: an SDK upgrade that changes
 * one of these signatures fails on one line here rather than at seven call
 * sites. `writeFile` reports no byte count and `killProcess` reports nothing at
 * all, which is why both results below are computed on this side.
 *
 * Spelled out rather than written as `SandboxHandle & { … }`. An intersection
 * of two object types that both declare `exec` produces an OVERLOADED `exec`,
 * and the first overload wins — so the narrower lifecycle signature, which has
 * no `env` option, would silently be the one every call here resolved against.
 * The two types still have to agree, and they do: this one is assignable to
 * `SandboxHandle`, which is what lets a test hand one fake to both halves.
 */
export type SandboxOpsHandle = {
  exec(
    command: string,
    options?: {
      timeout?: number;
      cwd?: string;
      /** Per-invocation, and the reason this type exists separately at all. */
      env?: Record<string, string | undefined>;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  killAllProcesses(): Promise<number>;
  startProcess(
    command: string,
    options?: {
      processId?: string;
      autoCleanup?: boolean;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): Promise<{ id: string }>;
  getProcess(id: string): Promise<ProcessSnapshot | null>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  killProcess(id: string, signal?: string): Promise<void>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<{ success: boolean }>;
  destroy(): Promise<void>;
  tunnels: { get(port: number): Promise<{ url: string }> };
};

/**
 * The one seam tests replace, and deliberately the LIFECYCLE's seam widened
 * rather than a second one: a test writes one fake container and both halves of
 * this module use it, so a fake cannot answer `boot` and the ops differently.
 */
export type SandboxGatewayDeps = {
  resolve?: (env: Env, runId: string) => SandboxOpsHandle;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Below this length a value is not redacted, and this is a REAL HOLE with a
 * real reason.
 *
 * A dev-env blob contains short values — `NODE_ENV=development`,
 * `NEXT_PUBLIC_APP_ENV=dev`, a port, a `true`. Replacing every occurrence of
 * `dev` in a build log destroys the log the model is trying to read, and does
 * it silently. Sixteen characters is comfortably below any real credential and
 * comfortably above any value that can appear in ordinary output by
 * coincidence, so the scrub covers everything worth covering and mangles
 * nothing. A genuinely short secret is not protected here; it is protected by
 * being dev-tier and read-scoped, which is the argument the README has to make
 * anyway.
 */
export const MIN_REDACTABLE_LENGTH = 16;

/** Names the variable, so a truncated log still says what was removed. */
const marker = (keyName: string): string => `[redacted:${keyName}]`;

/**
 * `git add -A -N` is intent-to-add: a from-scratch file appears in the diff
 * without staging its content, which is what makes a new file survive to
 * Phase 20's pull request instead of vanishing between the fix and the commit.
 */
const DIFF_COMMAND = "git add -A -N && git diff";

/** Long enough for a diff of a real fix; far short of an execution's budget. */
const DIFF_TIMEOUT_MS = 15_000;

const DEFAULT_REPO_PATH = "/workspace/web2app-rebuild";

/**
 * Deliberately the same call as `lifecycle.ts`'s, duplicated rather than
 * exported from there, because `transport: "rpc"` is required for `tunnels.*`
 * and throws at CALL time without it. A shared helper would hide which of the
 * two modules owns that decision; two lines that must agree, each next to what
 * it configures, is the smaller risk.
 */
function defaultResolve(env: Env, runId: string): SandboxOpsHandle {
  return getSandbox(env.SANDBOX, sandboxIdFor(runId), { transport: "rpc" });
}

/**
 * One scrubber, built once per gateway from the secret.
 *
 * Longest value first, so a value that contains another is replaced whole
 * rather than leaving a fragment of itself behind. `split`/`join` rather than a
 * regex, because building a pattern out of a credential means escaping a
 * credential, and a mistake there is a crash whose message quotes the thing it
 * was protecting.
 */
export function makeRedactor(devEnv: Record<string, string>): (text: string) => string {
  const replacements = Object.entries(devEnv)
    .filter(([, value]) => value.length >= MIN_REDACTABLE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);

  if (replacements.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const [keyName, value] of replacements) {
      if (out.includes(value)) out = out.split(value).join(marker(keyName));
    }
    return out;
  };
}

/**
 * The container, for one run.
 *
 * `deps` is the one seam tests replace; production callers never pass it. It is
 * the lifecycle's own seam type widened to this module's handle, so a test
 * writes one fake container and both halves use it.
 */
export function makeSandboxGateway(
  env: Env,
  runId: string,
  deps: SandboxGatewayDeps = {},
): SandboxGateway {
  // Assignable because `SandboxOpsHandle` is a superset of the lifecycle's
  // handle. Named as the lifecycle's own type at the call so a future widening
  // that broke that relationship fails HERE, in one place.
  const lifecycleDeps: SandboxLifecycleDeps = deps;
  const lifecycle = makeSandboxLifecycle(env, lifecycleDeps);
  const resolve = deps.resolve ?? defaultResolve;
  const sandbox = (): SandboxOpsHandle => resolve(env, runId);
  const repoPath = env.SANDBOX_REPO_PATH?.trim() || DEFAULT_REPO_PATH;

  /**
   * Built lazily and once. Lazily because a deployment with no dev-env secret
   * must still boot, exec and diff — `devEnvFor` is only strict about a secret
   * that EXISTS and is malformed. Once because it is read on every result.
   */
  let redactor: ((text: string) => string) | null = null;
  const redact = (text: string): string => {
    redactor ??= makeRedactor(devEnvFor(env));
    return redactor(text);
  };

  /**
   * Readiness is read from the container, not remembered in this isolate.
   *
   * `boot` is idempotent and never blocks, so it doubles as the status read.
   * The positive is cached for the life of this gateway — one run's
   * provisioning succeeds once and cannot un-succeed — while `provisioning` and
   * `failed` are re-read every time, because those are the states that change.
   *
   * A first call arriving here before any `boot` DOES start provisioning, and
   * that is deliberate: it is exactly what the model must do next, and the
   * refusal below tells it so. What it must not do is silently wait.
   */
  let ready = false;
  async function assertReady(): Promise<void> {
    if (ready) return;
    const status = await lifecycle.boot(runId);
    if (status.state === "ready") {
      ready = true;
      return;
    }
    throw new CapabilityError(
      "sandbox_not_ready",
      status.state === "failed"
        ? `the container for this run failed to provision (${status.note}), so nothing was run on it. Do not retry in a loop; report what failed.`
        : `the container for this run is still provisioning (${status.note}), so nothing was run on it. Call sandbox.boot() and check its state again on your next turn — boot is a poll, not a wait.`,
    );
  }

  return {
    boot: () => lifecycle.boot(runId),

    async exec(input): Promise<SandboxCommandResult> {
      await assertReady();
      const result = await sandbox().exec(input.cmd, {
        timeout: input.timeoutMs,
        cwd: input.cwd ?? repoPath,
        // Per-process, never `setEnvVars`: the container-wide environment stays
        // empty of dev-tier values, so they are not waiting in every future
        // command for a model that only asked for one.
        env: devEnvForProcess(env, input.injectDevEnv),
      });
      return {
        exitCode: result.exitCode,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
      };
    },

    async spawn(input) {
      await assertReady();
      const process = await sandbox().startProcess(input.cmd, {
        // WITHOUT THIS the SDK drops the process record on exit, so a finished
        // test run reads as "never started" and the model can never learn its
        // exit code — the same trap `boot` had to solve for provisioning.
        autoCleanup: false,
        cwd: input.cwd ?? repoPath,
        env: devEnvForProcess(env, input.injectDevEnv),
      });
      return { processId: process.id };
    },

    async checkProcess(processId): Promise<SandboxProcessState> {
      await assertReady();
      const handle = sandbox();
      const process = await handle.getProcess(processId);
      if (process === null) {
        throw new CapabilityError(
          "invalid_input",
          `no process with that id is known to this run's container. Use the processId sandbox.spawn returned; a container that was torn down forgets every process it had.`,
        );
      }
      const logs = await handle.getProcessLogs(processId);
      return {
        running: isRunning(process),
        exitCode: process.exitCode ?? null,
        stdoutTail: redact(logs.stdout),
        stderrTail: redact(logs.stderr),
      };
    },

    async killProcess(processId) {
      await assertReady();
      const handle = sandbox();
      // Asked first, so "there was nothing to kill" is a fact the model gets
      // rather than an upstream error it has to interpret. A process that is
      // already gone is not a failure — it is the state the caller wanted.
      if ((await handle.getProcess(processId)) === null) return { killed: false };
      await handle.killProcess(processId);
      return { killed: true };
    },

    async readFile(path) {
      await assertReady();
      const result = await sandbox().readFile(path);
      return { content: redact(result.content) };
    },

    async writeFile(path, content) {
      await assertReady();
      await sandbox().writeFile(path, content);
      // What we SENT, measured here, because the SDK's result carries no byte
      // count. Named `bytesWritten` and computed from the encoded form so it is
      // bytes rather than JavaScript characters, which differ the moment a file
      // contains a single non-ASCII character.
      return { bytesWritten: new TextEncoder().encode(content).byteLength };
    },

    async preview(port) {
      await assertReady();
      try {
        return await lifecycle.preview(runId, port);
      } catch (error) {
        // The lifecycle's message is ours and carries no secret: it names the
        // port, the last status and the retry window, which is precisely what
        // the model needs to decide whether its server ever started. Letting it
        // fall through to `safeMessage` would collapse all of that into
        // "the upstream service failed".
        throw new CapabilityError(
          "upstream_unavailable",
          error instanceof Error ? error.message : "the preview tunnel could not be reached.",
          { retryable: true },
        );
      }
    },

    async diff(): Promise<DiffResult> {
      await assertReady();
      const result = await sandbox().exec(DIFF_COMMAND, {
        timeout: DIFF_TIMEOUT_MS,
        cwd: repoPath,
      });
      if (result.exitCode !== 0) {
        throw new CapabilityError(
          "upstream_unavailable",
          `the working tree could not be diffed (exit ${result.exitCode}). ${redact(result.stderr).slice(0, 400)}`,
        );
      }

      // The RAW text is stored, unredacted and byte-exact, because Phase 20
      // builds a commit from it and a scrubbed patch is a broken patch. Only
      // the PREVIEW is scrubbed — it is the half the model sees, and it already
      // says in its own truncation marker that it must not be reconstructed
      // from. A dev-env value that reached a source file is a bug the diff has
      // to carry faithfully and the transcript must not repeat.
      const captured = await captureDiff(env, runId, result.stdout);
      return { ...captured, preview: redact(captured.preview) };
    },
  };
}

/** `starting` counts as running: the process exists and has not exited. */
function isRunning(process: ProcessSnapshot): boolean {
  return process.status === "starting" || process.status === "running";
}
