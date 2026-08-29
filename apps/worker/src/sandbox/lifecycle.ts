/**
 * Phase 18 Task 4 — one container per run, and every way it ends.
 *
 * The shape of this module is decided by one number: a Tier 1 execution is
 * capped at `wallTimeMs: 20_000` (`src/codemode/contracts.ts`) and provisioning
 * the monorepo is measured in tens of seconds. So `boot` NEVER blocks on
 * provisioning — it starts `provision.sh` as a background process and reports
 * on it, and every later call reports again. The agent loop already reasons
 * across calls, so "still installing, check again" is a turn rather than an
 * error path.
 *
 * The state lives in the container's process table, not in this isolate and not
 * in any new storage. That is deliberate: an isolate is recycled between
 * executions and a flag in one would say "provisioning" forever after an
 * eviction, while the process itself is the only thing that actually knows.
 */
import { getSandbox } from "@cloudflare/sandbox";
import { and, desc, gte, inArray } from "drizzle-orm";
import { orm } from "../db/client";
import { runs } from "../db/tables";
import type { Env } from "../index";
import { TERMINAL_RUN_STATUSES } from "../run/protocol";
import {
  assertGitSentinel,
  MONOREPO_SLUG,
  PLACEHOLDER_CREDENTIAL,
} from "./class";

export type BootState = "provisioning" | "ready" | "failed";

export type BootStatus = {
  state: BootState;
  /** Commit the working tree is on, once ready. */
  commit: string | null;
  /** Absolute path of the checkout inside the container. */
  repoPath: string;
  elapsedMs: number;
  /** One human-readable line: which provisioning step is running, or why it failed. */
  note: string;
};

export interface SandboxLifecycle {
  /** Idempotent. First call provisions; later calls report. Never blocks on provisioning. */
  boot(runId: string): Promise<BootStatus>;
  /** Idempotent and safe on a run that never booted. */
  teardown(runId: string): Promise<void>;
  /** TCP-level readiness. Rejects 3000 and anything outside 1024–65535. */
  waitForPort(runId: string, port: number, timeoutMs: number): Promise<boolean>;
  /** Tunnel URL, probed until it actually serves rather than on creation. */
  preview(runId: string, port: number): Promise<{ url: string }>;
}

/**
 * The subset of `@cloudflare/sandbox`'s `Sandbox` this module uses, named so it
 * can be replaced in tests without a live container.
 *
 * It is written structurally rather than as `Pick<Sandbox, …>` so that `tsc`
 * checks the real class against it at `defaultResolve` below: if an SDK upgrade
 * changes one of these signatures, the failure lands there, on one line, rather
 * than scattered across the call sites.
 */
export type SandboxHandle = {
  exec(
    command: string,
    options?: { timeout?: number; cwd?: string }
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
  destroy(): Promise<void>;
  tunnels: { get(port: number): Promise<{ url: string }> };
};

/**
 * `startTime` is declared `Date` by the SDK and arrives as one over the RPC
 * transport's structured clone — but it is a plain ISO string under the HTTP
 * transport, and the transport is a call-site option rather than a type. Widened
 * here so a transport change cannot turn `elapsedMs` into `NaN` silently.
 */
export type ProcessSnapshot = {
  id: string;
  status: string;
  exitCode?: number;
  startTime: Date | string;
};

/** The one seam tests replace. Production callers never pass it. */
export type SandboxLifecycleDeps = {
  resolve?: (env: Env, runId: string) => SandboxHandle;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The model never supplies, sees, or can guess this. A sandbox belongs to
 * exactly one run and is never shared or reused (invariant 3).
 */
export function sandboxIdFor(runId: string): string {
  return `run:${runId}`;
}

/**
 * A FIXED process id, and that is the entire persistence mechanism.
 *
 * `getProcess(PROVISION_PROCESS_ID)` answers "has provisioning already been
 * started, and how did it go" from the container itself. A generated id would
 * have to be stored somewhere, and anywhere it could be stored is somewhere it
 * could disagree with the container.
 */
const PROVISION_PROCESS_ID = "provision";

/** Baked into the image at this path so a `git clean` can never delete it. */
const PROVISION_SCRIPT = "/usr/local/bin/provision.sh";

/**
 * How long a live provision process may stay COMPLETELY silent before it is
 * declared wedged. provision.sh prints its first STEP line within milliseconds
 * of running and announces every step before starting minutes of work, so
 * "alive with zero output" has no healthy reading at this age. Generous anyway:
 * the false-positive cost is a spurious relaunch, the false-negative cost is a
 * run polling politely until its step ceiling kills it.
 */
const WEDGED_AFTER_MS = 75_000;

/** Sentinel note, compared by identity in bootOnce to trigger the one relaunch. */
const WEDGED_NOTE =
  "provisioning produced no output for over a minute and was declared wedged";

/**
 * Runs that already spent their one wedge-relaunch. Module scope for the same
 * reason as `inflightBoots`: lifecycle objects are made per capability call,
 * and this fact must outlive all of them.
 */
const relaunchedRuns = new Set<string>();

/**
 * The overall provisioning deadline, covering the hang shape the zero-output
 * wedge cannot: a process that printed a STEP and THEN stalled forever — a git
 * fetch that never completes, a tarball that never arrives. Without this, such
 * a stall reports its last step until the run dies at the step ceiling, which
 * is the polite-poll death all over again with one line of progress as an
 * alibi.
 *
 * Ten minutes against a measured ~3-minute cold boot: 3x headroom, because the
 * false-positive cost is a failed run that must re-ask, while the
 * false-negative cost is bounded anyway by the step ceiling — this deadline
 * exists to make the failure NAMED rather than ambient.
 */
const PROVISION_DEADLINE_MS = 600_000;

const DEFAULT_REPO_PATH = "/workspace/web2app-rebuild";

/**
 * Product PRs target `staging`, so that is what the working tree tracks.
 *
 * COUPLED TO `GITHUB_BASE`, which is configuration and defaults to the same
 * branch. This constant decides what the container checks out and therefore
 * what `baseSha` points at; `GITHUB_BASE` decides what the pull request opens
 * against. They agree today only by a coincidence of defaults, and the two are
 * changed by different people for different reasons — so if this value ever
 * moves, `GITHUB_BASE` has to move with it. The dangerous mismatch (tree cut
 * from a branch that is NOT contained in the PR base) would otherwise ship
 * that branch's commits into the base on merge; `assertBaseContains` in
 * `src/git/commit.ts` refuses it with a `GET /compare` before anything is
 * written, and carries the full reasoning.
 */
const REPO_REF = "staging";

/** Writing one line of git config; anything slower than this is a sick container. */
const GIT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * The sandbox's OWN control server, and the spike's worst trap because it fails
 * by SUCCEEDING: a readiness check against 3000 answers from the sandbox itself
 * and reports a dev server that was never running (it returned a confident
 * 752 ms for a process that had already exited).
 */
const SANDBOX_CONTROL_PORT = 3000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** How often the in-container probe retries, and how long a probe may run. */
const PORT_PROBE_INTERVAL_MS = 500;
/**
 * A wait longer than this cannot return inside a Tier 1 execution's 20 s
 * budget, so asking for one only converts a readable `false` into a killed
 * execution. Clamped rather than refused: `false` is a true answer.
 */
const MAX_WAIT_FOR_PORT_MS = 15_000;
/** Slack over the probe's own deadline, so `exec` never wins the race. */
const PORT_PROBE_GRACE_MS = 5_000;

/**
 * A fresh quick tunnel answers 530 for several seconds while it propagates, so
 * a single probe reads as a broken tunnel. Ten attempts a second apart is the
 * spike's measured ~10 s.
 */
const TUNNEL_PROBE_ATTEMPTS = 10;
const TUNNEL_PROBE_INTERVAL_MS = 1_000;
/**
 * The ONLY status worth retrying. A 500 is not retried on purpose: an app that
 * errors on its own missing config is serving, and waiting ten seconds to
 * report that as a broken tunnel would hide the real problem behind a fake one.
 */
const TUNNEL_PROPAGATING_STATUS = 530;

/**
 * Terminal runs updated inside this window. Unbounded, the sweep would wake a
 * Durable Object for every run this system has ever finished, every minute; a
 * window an order of magnitude longer than a teardown needs costs a handful of
 * redundant destroys per run instead.
 */
const SWEEP_WINDOW_MS = 15 * 60_000;
const SWEEP_MAX_RUNS = 50;

/**
 * Whether this deployment has a container runtime at all.
 *
 * Same shape and the same justification as `AGENT_MODEL_DISABLED`
 * (`agent/ports.ts`): a DELIBERATE opt-out, read strictly, and deliberately NOT
 * in wrangler.jsonc `vars`, so a deployed Worker never carries it and absence
 * means "containers are expected to work".
 *
 * It exists because of one hard fact about the test pool: `@cloudflare/
 * containers` throws "Containers have not been enabled for this Durable Object
 * class" from the `Sandbox` CONSTRUCTOR when no container runtime is present,
 * and vitest-pool-workers surfaces that as an unhandled rejection from its own
 * stub wrapper — noise no caller-side `catch` can reach. The two places that
 * touch a container WITHOUT a caller having asked for one (the sweeper, and the
 * terminal-status teardown hook) consult this first, so a suite that merely
 * finishes a run does not wake a class that cannot be constructed.
 *
 * It gates only those two. `boot`, `preview` and `waitForPort` are reached from
 * model-authored code that asked for a machine by name, and must fail loudly
 * rather than pretend to have one.
 */
export function sandboxContainersAvailable(env: Env): boolean {
  const raw = env.SANDBOX_DISABLED?.trim().toLowerCase() ?? "";
  return !(raw === "1" || raw === "true");
}

/**
 * `transport: "rpc"` is REQUIRED for `tunnels.*` and throws at CALL time, not
 * at construction, without it — so the failure surfaces inside `preview`, a
 * long way from this line. It is not mentioned in the tunnels documentation.
 */
function defaultResolve(env: Env, runId: string): SandboxHandle {
  return getSandbox(env.SANDBOX, sandboxIdFor(runId), { transport: "rpc" });
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single-flight, at module scope rather than per instance.
 *
 * `makeSandboxLifecycle` is called wherever a capability needs it, so two
 * concurrent `boot()` calls in one execution are usually two DIFFERENT
 * lifecycle objects over the same run. Keyed by run, they still coalesce to one
 * `startProcess`, which is what invariant 2 asks for. Deleted on settle, so
 * this is a de-duplicator and never a cache — a later poll must read the
 * container again, or `provisioning` would be the permanent answer.
 */
const inflightBoots = new Map<string, Promise<BootStatus>>();

export function makeSandboxLifecycle(
  env: Env,
  deps: SandboxLifecycleDeps = {}
): SandboxLifecycle {
  const resolve = deps.resolve ?? defaultResolve;
  const sleep = deps.sleep ?? defaultSleep;
  const repoPath = env.SANDBOX_REPO_PATH?.trim() || DEFAULT_REPO_PATH;

  async function startProvisioning(
    sandbox: SandboxHandle
  ): Promise<BootStatus> {
    // BEFORE ANYTHING ELSE. A process that failed `waitForPort` on an earlier
    // attempt is not reaped by the SDK: it keeps running, holds its port, and
    // the next attempt dies with EADDRINUSE — masking the real error with a
    // spurious one that points at the wrong thing entirely.
    await sandbox.killAllProcesses();

    // The image cloned through github.com with a build-time secret; the RUNNING
    // container must reach git through the sentinel host instead, where the
    // Worker's outbound interceptor swaps in the real PAT on egress. The
    // credential written here is a placeholder by name, and the interceptor
    // overwrites the Authorization header regardless of what the container sent.
    await sandbox.startProcess(PROVISION_SCRIPT, {
      processId: PROVISION_PROCESS_ID,
      // WITHOUT THIS, BOOT CANNOT BE A POLL. The SDK cleans a process record up
      // on exit by default, so a finished provision would read as "never
      // started" — every poll would relaunch it, a failure would retry forever,
      // and `ready` would be unreachable.
      autoCleanup: false,
      // NOT repoPath. The toolchain-only image does not contain the checkout —
      // creating it is this script's first job — and spawning with a cwd that
      // does not exist wedges the process record in "starting" with empty logs
      // forever: boot reports "starting up" on every poll, the model patiently
      // polls as instructed, and the run dies at its step ceiling. Found live
      // (run 17d0a274), introduced by the same commit that stopped baking the
      // repo, invisible to the unit tests because the stub cannot know which
      // directories exist. The script cds where it needs to on its own.
      cwd: "/workspace",
      // NUCLEO_LICENSE_KEY rides along because `node_modules` is no longer
      // baked: provision.sh runs the install, and `nucleo-ui-outline-18`'s
      // preinstall verifies this key or the whole install fails with
      // ERR_PNPM_IGNORED_BUILDS. Per-process like everything else, so it is
      // absent from the container's ambient environment; `''` when unset, which
      // provision.sh surfaces as a named failure rather than a mystery.
      // The remote is passed rather than configured by a separate `exec`,
      // because the repository may not exist yet: the image no longer bakes it
      // (see the Dockerfile), so a cold container clones and a warm one fetches,
      // and only provision.sh knows which case it is in.
      //
      // What must stay true either way, and what the test pins: this URL carries
      // the PLACEHOLDER, never a real credential. The sentinel host is swapped
      // for github.com Worker-side on egress.
      env: {
        SANDBOX_REPO_PATH: repoPath,
        SANDBOX_REPO_REF: REPO_REF,
        SANDBOX_GIT_REMOTE: gitRemoteUrl(env),
        NUCLEO_LICENSE_KEY: env.NUCLEO_LICENSE_KEY ?? "",
      },
    });

    return {
      state: "provisioning",
      commit: null,
      repoPath,
      elapsedMs: 0,
      note: "provisioning started",
    };
  }

  async function report(
    sandbox: SandboxHandle,
    process: ProcessSnapshot
  ): Promise<BootStatus> {
    const logs = await sandbox.getProcessLogs(process.id);
    const progress = readProgress(logs.stdout);
    const elapsedMs = Math.max(0, Date.now() - startedAtMs(process.startTime));

    if (process.status === "starting" || process.status === "running") {
      // A live process that has said NOTHING for this long is not slow, it is
      // wedged. provision.sh prints its first STEP line within milliseconds of
      // actually running, and every later step announces itself before minutes
      // of work — so "alive, zero output, over a minute" has no healthy
      // reading. Observed live twice: a spawn against a nonexistent cwd left a
      // record parked in "starting" forever, and a deploy mid-run preserved
      // that corpse for the NEW code to poll faithfully (autoCleanup: false
      // keeps records — including dead ones). Without this, boot reports
      // "starting up" until the run dies at its step ceiling, which is the
      // silent-failure shape everything in this phase exists to avoid.
      if (progress.step === null && elapsedMs > WEDGED_AFTER_MS) {
        return {
          state: "failed",
          commit: null,
          repoPath,
          elapsedMs,
          note: WEDGED_NOTE,
        };
      }
      // The other hang shape: progress WAS made, then stopped. Terminal and
      // named, not relaunched — a relaunch would redo minutes of work behind an
      // opaque status, and a stall this long usually means the network path it
      // stalled on will stall again.
      if (elapsedMs > PROVISION_DEADLINE_MS) {
        return {
          state: "failed",
          commit: null,
          repoPath,
          elapsedMs,
          note: `provisioning exceeded its ${Math.round(PROVISION_DEADLINE_MS / 60_000)}-minute deadline, last step "${progress.step ?? "none"}"; the machine is unusable for this run`,
        };
      }
      return {
        state: "provisioning",
        commit: null,
        repoPath,
        elapsedMs,
        note: progress.note,
      };
    }
    if (process.status === "completed" && (process.exitCode ?? 0) === 0) {
      return {
        state: "ready",
        commit: progress.commit,
        repoPath,
        elapsedMs,
        note: progress.commit
          ? "ready"
          : "provisioning finished but printed no commit — the checkout may be mid-rebase",
      };
    }
    return {
      state: "failed",
      commit: null,
      repoPath,
      elapsedMs,
      note: `provisioning failed at "${progress.failedStep ?? progress.step ?? "an unknown step"}": ${progress.note}`,
    };
  }

  async function bootOnce(runId: string): Promise<BootStatus> {
    const sandbox = resolve(env, runId);
    const existing = await sandbox.getProcess(PROVISION_PROCESS_ID);
    // A record that exists is the answer, whatever it says. A failed provision
    // is reported as failed on every later call and never relaunched: retrying
    // a `pnpm install` that failed on a lockfile conflict just burns the budget
    // and hides the reason.
    if (existing) {
      const status = await report(sandbox, existing);
      // One exception to "never relaunch", for exactly one failure mode: a
      // WEDGED record — alive, silent past the deadline. That state has a known
      // benign cause (a deploy mid-boot preserves the old code's spawn as a
      // corpse the new code polls forever) which one clean relaunch heals. Once
      // only, tracked per run: a second wedge means the cause is in the current
      // code, and relaunching in a loop would re-create the exact
      // poll-until-step-ceiling death this detection exists to prevent.
      if (
        status.state === "failed" &&
        status.note === WEDGED_NOTE &&
        !relaunchedRuns.has(runId)
      ) {
        relaunchedRuns.add(runId);
        await sandbox.killAllProcesses();
        return startProvisioning(sandbox);
      }
      return status;
    }
    return startProvisioning(sandbox);
  }

  return {
    boot(runId) {
      const inflight = inflightBoots.get(runId);
      if (inflight) return inflight;
      const started = bootOnce(runId).finally(() => {
        inflightBoots.delete(runId);
      });
      inflightBoots.set(runId, started);
      return started;
    },

    /**
     * Errors propagate. Both callers — the terminal-status hook and the sweeper
     * — treat a failed destroy as non-fatal, but they treat it differently (one
     * warns, one keeps counting), and a swallow here would take that choice
     * away from them and hide a container that is still burning budget.
     */
    async teardown(runId) {
      inflightBoots.delete(runId);
      await resolve(env, runId).destroy();
    },

    async waitForPort(runId, port, timeoutMs) {
      assertUsablePort(port);
      const budgetMs = Math.min(Math.max(0, timeoutMs), MAX_WAIT_FOR_PORT_MS);
      const attempts = Math.max(
        1,
        Math.ceil(budgetMs / PORT_PROBE_INTERVAL_MS)
      );
      const result = await resolve(env, runId).exec(tcpProbe(port, attempts), {
        timeout: budgetMs + PORT_PROBE_GRACE_MS,
      });
      return result.exitCode === 0;
    },

    async preview(runId, port) {
      assertUsablePort(port);
      const { url } = await resolve(env, runId).tunnels.get(port);

      let lastStatus: number | null = null;
      for (let attempt = 0; attempt < TUNNEL_PROBE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await sleep(TUNNEL_PROBE_INTERVAL_MS);
        try {
          const response = await fetch(url, {
            method: "GET",
            redirect: "manual",
          });
          lastStatus = response.status;
          if (response.status !== TUNNEL_PROPAGATING_STATUS) return { url };
        } catch {
          // A connection that never opened is the same state as a 530: the
          // tunnel exists as a record and does not yet route.
          lastStatus = null;
        }
      }

      throw new Error(
        `the tunnel for port ${port} never served (last status ${lastStatus ?? "unreachable"}). ` +
          `A fresh tunnel answers ${TUNNEL_PROPAGATING_STATUS} while it propagates, so this was retried for ` +
          `${(TUNNEL_PROBE_ATTEMPTS * TUNNEL_PROBE_INTERVAL_MS) / 1000}s — check that something is listening on ${port}.`
      );
    },
  };
}

/**
 * Destroy containers for runs that have already finished.
 *
 * The terminal-status hook in `run/do.ts` is what normally destroys a
 * container; this is the repair path for the run that crashed, was evicted, or
 * whose hook lost its `waitUntil`. One container whose destroy throws must not
 * stop the sweep — that container is exactly the one most likely to be stuck,
 * and skipping the rest of the list because of it is how a single wedged
 * machine turns into a wedged fleet.
 */
export async function sweepSandboxes(
  env: Env,
  deps: SandboxLifecycleDeps = {}
): Promise<{ destroyed: number }> {
  if (!sandboxContainersAvailable(env)) return { destroyed: 0 };

  const lifecycle = makeSandboxLifecycle(env, deps);
  const results = await orm(env.DB)
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        inArray(runs.status, TERMINAL_RUN_STATUSES),
        gte(runs.updated_at, Date.now() - SWEEP_WINDOW_MS)
      )
    )
    .orderBy(desc(runs.updated_at))
    .limit(SWEEP_MAX_RUNS)
    .all();

  let destroyed = 0;
  for (const row of results ?? []) {
    try {
      await lifecycle.teardown(row.id);
      destroyed += 1;
    } catch (error) {
      console.warn("sandbox sweep: destroy failed", {
        runId: row.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return { destroyed };
}

/**
 * `assertGitSentinel` is called HERE, at the one place the remote URL is built.
 * The sentinel host is duplicated as a module constant and a wrangler var
 * (unavoidably: `static outboundByHost` is read at DO construction, with no
 * `env` in scope), and a drift between the two shows up as a DNS failure inside
 * a container a long way from its cause.
 */
function gitRemoteUrl(env: Env): string {
  const host = assertGitSentinel(env);
  return `https://x-access-token:${PLACEHOLDER_CREDENTIAL}@${host}/${MONOREPO_SLUG}.git`;
}

/**
 * Both port-taking methods refuse 3000 FIRST and by name, because it is not an
 * out-of-range value — it is a plausible, conventional, correct-looking port
 * that silently answers for the wrong server.
 */
function assertUsablePort(port: number): void {
  if (port === SANDBOX_CONTROL_PORT) {
    throw new Error(
      "port 3000 is the sandbox's own control server: a readiness check against it succeeds " +
        "whether or not your process is running, so it reports a dev server that never started. " +
        "Bind somewhere in 4100+ (the monorepo's own apps already claim 3000-3010)."
    );
  }
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `port ${port} is out of range: it must be an integer in 1024-65535.`
    );
  }
}

/**
 * A TCP connect loop, run inside the container.
 *
 * The SDK's own `waitForPort({ mode: 'tcp' })` is declared ONLY on a `Process`
 * handle, and this method is given a port rather than a process — so the check
 * is spelled out instead. It asks the question that matters, "is anything
 * listening", rather than the HTTP-mode question, "does it answer 2xx": an app
 * that 500s on missing config is listening, and that is precisely the state a
 * repro loop most needs to tell apart from a dead one.
 */
function tcpProbe(port: number, attempts: number): string {
  const loop =
    `for _ in $(seq 1 ${attempts}); do ` +
    `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then exit 0; fi; ` +
    `sleep ${PORT_PROBE_INTERVAL_MS / 1000}; done; exit 1`;
  return `bash -c '${loop}'`;
}

type Progress = {
  step: string | null;
  failedStep: string | null;
  commit: string | null;
  note: string;
};

/**
 * `provision.sh` speaks in single parseable lines — `STEP <name>`, `FAILED
 * <name>`, and the commit SHA printed after `STEP ready` — precisely so this
 * can turn them into the one line a human watching a Slack thread wants.
 *
 * `clean` appears only as a `FAILED` (the script emits `STEP reset` and then
 * does both), which is why the note table covers steps that are never announced.
 */
const STEP_NOTES: Record<string, string> = {
  clone:
    "cloning the monorepo (~400 MB even shallow; the largest transfer of a cold boot)",
  "clone-retry-1": "first clone attempt failed or stalled; retrying",
  "clone-retry-2": "second clone attempt failed or stalled; retrying",
  "set-remote": "pointing the checkout at origin",
  fetch: `fetching origin/${REPO_REF}`,
  "fetch-skipped-baked": "the fetch stalled; using the baked snapshot instead",
  reset: "resetting the working tree",
  clean: "removing files a previous run left behind",
  install: "installing dependencies",
  "restore-tracked": "restoring tracked files the install's scripts modified",
  "build-packages": "building the workspace packages",
  browser: "installing the browser (Chromium; non-fatal if it fails)",
  "browser-cached": "browser already installed",
  "browser-unavailable":
    "browser install failed; recording is unavailable on this machine",
  ready: "ready",
};

function readProgress(stdout: string): Progress {
  let step: string | null = null;
  let failedStep: string | null = null;
  let commit: string | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("STEP ")) step = line.slice(5).trim();
    else if (line.startsWith("FAILED ")) failedStep = line.slice(7).trim();
    // The SHA is printed after `STEP ready` and is the only bare hex line the
    // script emits. Matched by shape rather than by position so an unrelated
    // trailing newline or a warning on stdout cannot shift it.
    else if (/^[0-9a-f]{40}$/.test(line)) commit = line;
  }

  const named = failedStep ?? step;
  const note = named ? (STEP_NOTES[named] ?? named) : "starting up";
  return { step, failedStep, commit, note };
}

function startedAtMs(startTime: Date | string): number {
  const parsed =
    startTime instanceof Date ? startTime.getTime() : Date.parse(startTime);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
