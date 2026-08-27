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
} from "../gateways/ports";
import { CapabilityError } from "../gateways/errors";
import type { Env } from "../index";
import { captureDiff, type DiffResult } from "./diff";
import { devEnvFor, devEnvForProcess } from "./env";
import {
  makeSandboxLifecycle,
  sandboxIdFor,
  type ProcessSnapshot,
  type SandboxLifecycleDeps,
} from "./lifecycle";
import {
  startRecording,
  checkRecording as runCheckRecording,
  type RecordDeps,
} from "./record";
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
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  killAllProcesses(): Promise<number>;
  startProcess(
    command: string,
    options?: {
      processId?: string;
      autoCleanup?: boolean;
      cwd?: string;
      env?: Record<string, string | undefined>;
    }
  ): Promise<{ id: string }>;
  getProcess(id: string): Promise<ProcessSnapshot | null>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  killProcess(id: string, signal?: string): Promise<void>;
  /**
   * Overloaded on purpose, matching the SDK's own `readFile` exactly —
   * `{ encoding: "none" }` is the RPC-transport raw-byte variant `readBinary`
   * needs; the no-options call is the existing TEXT read every other method
   * here uses. See `readBinaryFile` below for why this is the ONLY correct
   * way to get raw bytes out of the container: the SDK's separately-named
   * `readFileStream` looks like it does the same thing and does not.
   */
  readFile(
    path: string,
    options: { encoding: "none" }
  ): Promise<{ content: ReadableStream<Uint8Array>; size: number }>;
  readFile(
    path: string,
    options?: { encoding?: string }
  ): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<{ success: boolean }>;
  /**
   * `mkdir -p`. Present because `writeFile` does NOT create missing parents —
   * it is a POST to the container's file server and says nothing about them,
   * and the SDK's own mount path calls this first. `record.ts` needs the
   * recording's working directory to exist before it writes a script into it.
   */
  mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<{ success: boolean }>;
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
 *
 * Diffed against `HEAD`, not the index. `-A` fully stages every change,
 * including a deletion — so an unstaged `git diff` (no `HEAD`) reports nothing
 * for a deleted file: `git status --short` shows `D ` in the index column, but
 * `git diff` has nothing left to compare the empty index entry against. `git
 * diff HEAD` compares the working tree to the last commit regardless of what
 * is staged, so both a `new file mode` and a `deleted file mode` header come
 * out — which is exactly what Phase 20's applier parses. It is also the
 * commit `captureDiff`'s `baseSha` records, so the diff and the sha it is
 * captured against can no longer disagree just because something was already
 * staged before this command ran.
 */
const DIFF_COMMAND = "git add -A -N && git diff HEAD";

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
export function makeRedactor(
  devEnv: Record<string, string>
): (text: string) => string {
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
const defaultGatewaySleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function makeSandboxGateway(
  env: Env,
  runId: string,
  deps: SandboxGatewayDeps = {}
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
        : `the container for this run is still provisioning (${status.note}), so nothing was run on it. Call sandbox.boot() and check its state again on your next turn — boot is a poll, not a wait.`
    );
  }

  /**
   * Raw bytes out of the container, for `readBinary` and for `record.ts`'s own
   * `readBinary` dependency — one implementation, because both callers want
   * the identical stream and neither wants to buffer it.
   *
   * MUST be `readFile(path, { encoding: "none" })`, never `readFileStream`.
   * The two look interchangeable — both are named for streaming and both type
   * as `Promise<ReadableStream<Uint8Array>>` — and they are not the same
   * call. `readFileStream` is Server-Sent-Events framing: `data: {...}`
   * envelopes carrying base64 chunks, meant to be decoded with the SDK's own
   * `streamFile`/`parseSSEStream` helpers. Piped straight into `R2Bucket.put`
   * as this function does, that produces an object that uploads cleanly,
   * resolves at its URL, and is not a valid mp4 — nothing in this path would
   * catch it; a human clicking the link in a customer thread would.
   * `readFile(path, { encoding: "none" })` is documented as the RPC
   * transport's raw-byte variant — "no base64 encoding, no SSE framing, no
   * buffering" — which is what a recording's bytes actually need to stay.
   *
   * THE SIZE COMES BACK TOO, and it is not decoration. `ReadFileStreamResult`
   * is `{ success, path, content, size, mimeType, timestamp }`: the file's
   * length is authoritative, free on every call, and known before a byte is
   * read. Discarding it is what previously forced `record.ts` to buffer the
   * video in 8MiB parts to reach R2 at all.
   */
  async function readBinaryFile(
    path: string
  ): Promise<{ content: ReadableStream<Uint8Array>; size: number }> {
    await assertReady();
    const result = await sandbox().readFile(path, { encoding: "none" });
    return { content: result.content, size: result.size };
  }

  /**
   * `record.ts` remembers nothing between calls (see its own header), so this
   * is rebuilt on every `record`/`checkRecording` rather than cached — cheap,
   * since every field here is either a closure over `handle` or a plain read.
   */
  function buildRecordDeps(): RecordDeps {
    const handle = sandbox();
    const proofsBaseUrl = env.PROOFS_BASE_URL;
    if (!proofsBaseUrl) {
      throw new CapabilityError(
        "upstream_unavailable",
        "this deployment has no PROOFS_BASE_URL configured, so a recording could not be started or published."
      );
    }
    return {
      mkdir: (path, options) => handle.mkdir(path, options),
      writeFile: (path, content) => handle.writeFile(path, content),
      startProcess: (command, options) => handle.startProcess(command, options),
      getProcess: (id) => handle.getProcess(id),
      getProcessLogs: (id) => handle.getProcessLogs(id),
      readBinary: readBinaryFile,
      bucket: env.ARTIFACTS,
      proofsBaseUrl,
      // The VALUES, exactly as `redact` scrubs every other model-visible
      // field: a recording script drives a dev server that was handed these,
      // and `record.ts` redacts `stdoutTail` and `error` the same way `exec`
      // redacts its own output.
      devEnv: devEnvFor(env),
    };
  }

  return {
    // A LONG poll, when the binding asks for one: while provisioning, hold the
    // call up to ~14s (re-reading every 3s) before answering. Without this,
    // every poll costs one model step and buys ~2 seconds of wall time, and the
    // arithmetic can never close: a cold boot is minutes,
    // MAX_STEPS_PER_GENERATION is finite, and the run dies at its ceiling while
    // the machine underneath is HEALTHY — observed live, run 317111cd,
    // mid-`installing dependencies`.
    //
    // The binding grants the wait to the FIRST boot of each execution only.
    // Both halves were paid for live: no wait at all killed 317111cd at the
    // step ceiling, and an unconditional wait killed a block in 29f027e4 at
    // 25.7s of a 20s budget when the model reasonably called boot twice.
    boot: async (longPoll) => {
      let status = await lifecycle.boot(runId);
      if (!longPoll) return status;
      // Through the injected sleep, not a raw setTimeout: the same seam the
      // lifecycle uses, so tests exercise this loop in milliseconds.
      const sleep = deps.sleep ?? defaultGatewaySleep;
      const deadline = Date.now() + 14_000;
      while (status.state === "provisioning" && Date.now() + 3_000 < deadline) {
        await sleep(3_000);
        status = await lifecycle.boot(runId);
      }
      return status;
    },

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
          `no process with that id is known to this run's container. Use the processId sandbox.spawn returned; a container that was torn down forgets every process it had.`
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
      if ((await handle.getProcess(processId)) === null)
        return { killed: false };
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
          error instanceof Error
            ? error.message
            : "the preview tunnel could not be reached.",
          { retryable: true }
        );
      }
    },

    async diff(): Promise<DiffResult> {
      await assertReady();

      // Its own exec call, run BEFORE the diff and never concatenated into
      // `DIFF_COMMAND`: one command, one stdout. Mixing the sha into the same
      // stdout as the patch is how a sha ends up pasted inside the patch text
      // itself, which is exactly the byte-exactness this module exists to
      // protect.
      const head = await sandbox().exec("git rev-parse HEAD", {
        timeout: DIFF_TIMEOUT_MS,
        cwd: repoPath,
      });
      const baseSha = head.stdout.trim();
      // Fail loudly here rather than store a patch with no sha anyone can ever
      // apply it against. A non-zero exit or a value that is not a sha means a
      // detached or otherwise broken checkout — Phase 20 could not resolve a
      // base tree for it anyway, so refusing at capture time surfaces the
      // problem at the run that caused it instead of at PR time.
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
        throw new CapabilityError(
          "upstream_unavailable",
          `could not resolve the checkout's HEAD commit (exit ${head.exitCode}). ${redact(head.stderr).slice(0, 400)}`
        );
      }

      const result = await sandbox().exec(DIFF_COMMAND, {
        timeout: DIFF_TIMEOUT_MS,
        cwd: repoPath,
      });
      if (result.exitCode !== 0) {
        throw new CapabilityError(
          "upstream_unavailable",
          `the working tree could not be diffed (exit ${result.exitCode}). ${redact(result.stderr).slice(0, 400)}`
        );
      }

      // The RAW text is stored, unredacted and byte-exact, because Phase 20
      // builds a commit from it and a scrubbed patch is a broken patch. Only
      // the PREVIEW is scrubbed — it is the half the model sees, and it already
      // says in its own truncation marker that it must not be reconstructed
      // from. A dev-env value that reached a source file is a bug the diff has
      // to carry faithfully and the transcript must not repeat.
      const captured = await captureDiff(env, runId, result.stdout, baseSha);
      return { ...captured, preview: redact(captured.preview) };
    },

    readBinary: (path) => readBinaryFile(path),

    // Both delegate to `record.ts` — this gateway supplies the container
    // primitives and the R2/URL wiring, `record.ts` owns the harness
    // contract, the R2 key and the redaction of what it reads back. Gated by
    // `assertReady` up front, same as every other method here: a call before
    // `boot` refuses with `sandbox_not_ready` before either function runs.
    async record(input) {
      await assertReady();
      return startRecording(buildRecordDeps(), input);
    },

    async checkRecording(recordingId) {
      await assertReady();
      return runCheckRecording(buildRecordDeps(), recordingId);
    },
  };
}

/** `starting` counts as running: the process exists and has not exited. */
function isRunning(process: ProcessSnapshot): boolean {
  return process.status === "starting" || process.status === "running";
}
