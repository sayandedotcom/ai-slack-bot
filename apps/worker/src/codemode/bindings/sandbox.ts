import { z } from "zod";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { CapabilityError } from "../errors";
import { auditedCapability, type BindingContext } from "../registry";

/**
 * The ninth namespace: the agent's own machine.
 *
 * Assembled over three modules that already exist and are already tested —
 * `sandbox/lifecycle.ts`, `sandbox/env.ts`, `sandbox/diff.ts` — reached through
 * the `sandbox` gateway so that no `Env` enters `src/codemode/`. What this file
 * adds is the part that is model-facing and nothing else: schemas, bounds, and
 * refusals a model can read and act on.
 *
 * THE SHAPE IS DECIDED BY ONE NUMBER. A `run_code` execution is capped at
 * `wallTimeMs: 20_000`, and container work is measured in tens of seconds. So
 * nothing here blocks on slow work: `boot` is a poll, and `spawn` + `checkProcess`
 * replace a blocking `exec` for anything that cannot finish in a few seconds.
 * The agent loop already reasons across calls, so "still building, check again"
 * is a turn rather than an error path.
 *
 * EVERY METHOD IS `sandbox_write`, including the ones that look like reads.
 * `readFile` observes, but it observes a machine `exec` has been mutating, and
 * splitting the namespace across two classes would suggest a boundary inside it
 * that does not exist. See `write-guard.ts` for why the class exists at all.
 *
 * THE DESCRIPTIONS BELOW ARE PROMPT ENGINEERING, NOT DOCUMENTATION. They are
 * rendered verbatim into the declarations the model reads, and each one is
 * carrying a trap the spike or the monorepo audit paid for: port 3000 answering
 * for the wrong server, a `PORT` variable that does not override a CLI flag,
 * Infisical-wrapped dev scripts with no credential to authenticate with, a
 * repo-wide `biome` run that once rewrote 1585 files. Every sentence is there
 * because getting it wrong costs the model a turn or costs a human a review.
 */

/**
 * Well inside `PRODUCTION_LIMITS.wallTimeMs` (20_000), with room for the call
 * that made it and the result that comes back.
 *
 * REFUSED ABOVE THIS, NEVER CLAMPED. A silent clamp tells the model it has 60
 * seconds, kills the command at 15, and hands back a truncated failure it will
 * try to debug — the container looks broken and the real cause is invisible. A
 * refusal costs one turn and names `spawn`, which is the thing it should have
 * reached for.
 */
export const EXEC_TIMEOUT_CEILING_MS = 15_000;

/** What a command gets when it does not ask. Generous for a `git` or a `grep`. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

/**
 * Per stream, so a worst-case `exec` result is ~8_000 characters against
 * `maxResultChars` (24_000) — leaving room for whatever else the model's own
 * program returns alongside it. Unbounded output is how a capability result
 * blows that cap at the worst possible moment: at the end of the build whose
 * error you needed.
 */
export const EXEC_OUTPUT_CHARS = 4_000;

/** Two tails plus a result envelope, polled repeatedly. Smaller on purpose. */
export const PROCESS_TAIL_CHARS = 2_000;

/** One file, read deliberately. Larger than a tail, still a third of the cap. */
export const READ_FILE_CHARS = 8_000;

/**
 * The container's OWN control server, and the spike's worst trap, because it
 * fails by SUCCEEDING: a readiness check against 3000 answers from the sandbox
 * itself and reports a dev server that was never running.
 *
 * Checked HERE as well as in `lifecycle.ts` — not redundantly. The lifecycle
 * throws a plain `Error`, which `safeMessage` collapses to
 * "the upstream service failed"; the model needs the reason, and a reason only
 * survives to it as a `CapabilityError`. So the refusal happens before the call
 * rather than being translated after it.
 */
const CONTROL_PORT = 3000;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const bootStatus = z.strictObject({
  state: z.enum(["provisioning", "ready", "failed"]),
  commit: z.string().nullable(),
  repoPath: z.string(),
  elapsedMs: z.number(),
  note: z.string(),
});

const diffResult = z.strictObject({
  preview: z.string(),
  truncated: z.boolean(),
  filesChanged: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  diffRef: z.string().nullable(),
});

/**
 * `.default({})` is load-bearing on every zero-argument method: `ToolDispatcher`
 * spreads an empty argument array, so `sandbox.boot()` reaches
 * `execute(undefined)`. Without it, the call the generated types teach is the
 * one that fails validation.
 */
const noArgs = z.strictObject({}).default({});

export function makeSandboxTools(ctx: BindingContext): ToolDescriptors {
  return {
    boot: auditedCapability(ctx, "sandbox", "boot", {
      effect: "sandbox_write",
      description:
        "Start this run's container, or report on one already starting. Idempotent; each call waits up to ~14s for progress before answering, so polling is cheap — but a COLD machine clones the monorepo and installs from scratch, which takes 2-4 minutes (~10-14 boot calls). Budget for that: call boot early, do genuinely useful work between polls (read memory, draft from what you already know, send a brief status reply if warranted), and only wait on the machine when nothing else moves the task. If the question is answerable without code — a how-to, a status — answer it; the machine is for reproducing, editing and running, not a reflex. Every other capability here refuses with sandbox_not_ready until state is 'ready'. `note` names the current provisioning step; `repoPath` is where commands run by default, and `pnpm build-packages` has already run by the time state is 'ready'.",
      input: noArgs,
      output: bootStatus,
      run: () => ctx.deps.sandbox.boot(),
    }),

    exec: auditedCapability(ctx, "sandbox", "exec", {
      effect: "sandbox_write",
      description:
        "Run one command to completion and get its output. It blocks, so it must finish inside this execution's budget: timeoutMs defaults to 10000 and anything above 15000 is REFUSED rather than quietly shortened. Use spawn for installs, builds, test suites and servers. Runs in the checkout unless cwd says otherwise. Set injectDevEnv when the command needs the app's dev-tier environment — the monorepo's dev scripts are Infisical-wrapped and there is no credential to authenticate with here, so run the inner command directly and pass this flag instead of running `pnpm dev`. Output is truncated per stream and scrubbed of injected values, so do not try to print them.",
      input: z.strictObject({
        cmd: z.string().min(1).max(4_000),
        cwd: z.string().min(1).max(500).optional(),
        /**
         * Deliberately NOT `.max(EXEC_TIMEOUT_CEILING_MS)`. A zod bound reports
         * as `timeoutMs: too_big` through `formatZodIssues`, which names the
         * path and the rule and — correctly, for arbitrary model input — never
         * the value or the limit. This is the one case where the model needs
         * the number and the alternative, so the check is explicit below.
         */
        timeoutMs: z.number().int().min(1).optional(),
        injectDevEnv: z.boolean().optional(),
      }),
      output: z.strictObject({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number(),
        truncated: z.boolean(),
      }),
      run: async (input) => {
        const timeoutMs = input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
        assertTimeoutInBudget(timeoutMs);

        const result = await ctx.deps.sandbox.exec({
          cmd: input.cmd,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          timeoutMs,
          injectDevEnv: input.injectDevEnv ?? false,
        });

        // Bounded AFTER the gateway has scrubbed, never before. Cutting first
        // could leave the head of a value in the result and its tail in the
        // part that was dropped, which is a leak the flag would call a success.
        const stdout = clampHead(result.stdout, EXEC_OUTPUT_CHARS);
        const stderr = clampHead(result.stderr, EXEC_OUTPUT_CHARS);
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: result.exitCode,
          truncated: stdout.truncated || stderr.truncated,
        };
      },
    }),

    spawn: auditedCapability(ctx, "sandbox", "spawn", {
      effect: "sandbox_write",
      description:
        "Start a long-running command in the background and get a processId back. This is how anything slower than a few seconds is run — a dev server, a build, a test suite — because one execution has 20 seconds and a blocking command cannot outlive it. Poll it with checkProcess on later turns. NEVER bind a server to port 3000: three apps here default to it, the port is a CLI flag inside their package script so a PORT variable does NOT override it, and 3000 is the container's own control server. Use 4100 or above, e.g. `pnpm --filter @web2app/web exec next dev --port 4100`. Dev scripts are Infisical-wrapped and cannot authenticate here, so run the inner command directly and pass injectDevEnv: true.",
      input: z.strictObject({
        cmd: z.string().min(1).max(4_000),
        cwd: z.string().min(1).max(500).optional(),
        injectDevEnv: z.boolean().optional(),
      }),
      output: z.strictObject({ processId: z.string() }),
      run: (input) =>
        ctx.deps.sandbox.spawn({
          cmd: input.cmd,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          injectDevEnv: input.injectDevEnv ?? false,
        }),
    }),

    checkProcess: auditedCapability(ctx, "sandbox", "checkProcess", {
      effect: "sandbox_write",
      description:
        "Report on a process spawn started: whether it is still running, its exit code once it is not, and the tail of each output stream. This is the poll — call it on a later turn rather than looping here, since waiting burns the same 20 second budget the process needs. A server that is listening but erroring is still 'running'; read the tails to tell those apart.",
      input: z.strictObject({ processId: z.string().min(1).max(200) }),
      output: z.strictObject({
        running: z.boolean(),
        exitCode: z.number().nullable(),
        stdoutTail: z.string(),
        stderrTail: z.string(),
      }),
      run: async (input) => {
        const state = await ctx.deps.sandbox.checkProcess(input.processId);
        return {
          running: state.running,
          exitCode: state.exitCode,
          // The TAIL, not the head. A process is polled while it works, and the
          // line that explains what it is doing now — or why it just died — is
          // always the last one.
          stdoutTail: clampTail(state.stdoutTail, PROCESS_TAIL_CHARS),
          stderrTail: clampTail(state.stderrTail, PROCESS_TAIL_CHARS),
        };
      },
    }),

    killProcess: auditedCapability(ctx, "sandbox", "killProcess", {
      effect: "sandbox_write",
      description:
        "Stop a process this run started. `killed: false` means there was no such process, which is a fact rather than an error. Kill a dev server before starting another on the same port: a process that failed to come up is not reaped, keeps its port, and the next attempt dies with EADDRINUSE pointing at the wrong problem.",
      input: z.strictObject({ processId: z.string().min(1).max(200) }),
      output: z.strictObject({ killed: z.boolean() }),
      run: (input) => ctx.deps.sandbox.killProcess(input.processId),
    }),

    readFile: auditedCapability(ctx, "sandbox", "readFile", {
      effect: "sandbox_write",
      description:
        "Read a text file from the container. Content is truncated with a visible marker and scrubbed of injected environment values. Narrow first with exec and grep or sed rather than reading a large file and searching it here — that is the whole reason you are running code instead of calling tools one at a time.",
      input: z.strictObject({ path: z.string().min(1).max(1_000) }),
      output: z.strictObject({ content: z.string(), truncated: z.boolean() }),
      run: async (input) => {
        const result = await ctx.deps.sandbox.readFile(input.path);
        const content = clampHead(result.content, READ_FILE_CHARS);
        return { content: content.text, truncated: content.truncated };
      },
    }),

    writeFile: auditedCapability(ctx, "sandbox", "writeFile", {
      effect: "sandbox_write",
      description:
        "Write a text file in the container, creating or replacing it whole. Before calling diff, format every file you edited with `pnpm exec biome check --write` and the explicit paths — this repo blocks unformatted commits. NEVER pass a directory or a computed-empty list to that command: it then sweeps the entire repo and rewrites files you never touched.",
      input: z.strictObject({
        path: z.string().min(1).max(1_000),
        content: z.string().max(200_000),
      }),
      output: z.strictObject({ bytesWritten: z.number() }),
      run: (input) => ctx.deps.sandbox.writeFile(input.path, input.content),
    }),

    preview: auditedCapability(ctx, "sandbox", "preview", {
      effect: "sandbox_write",
      description:
        "Open a public URL for a port inside the container and wait until it actually serves — a fresh tunnel answers 530 for several seconds, so this retries rather than reporting a broken one. Port 3000 is refused: it is the container's own control server, so a check against it succeeds whether or not your server ever started. Bind and preview 4100 or above.",
      input: z.strictObject({ port: z.number() }),
      output: z.strictObject({ url: z.string() }),
      run: async (input) => {
        assertUsablePort(input.port);
        return ctx.deps.sandbox.preview(input.port);
      },
    }),

    diff: auditedCapability(ctx, "sandbox", "diff", {
      effect: "sandbox_write",
      description:
        "Capture everything changed in the checkout, including new files. Returns a bounded preview plus an opaque diffRef; the full patch is stored intact and is what a pull request will be built from, so never reconstruct it from the preview or paste it back. `diffRef: null` means nothing changed. Format your edited files first — an unformatted change arrives as a review comment rather than a merge.",
      input: noArgs,
      output: diffResult,
      run: () => ctx.deps.sandbox.diff(),
    }),
  };
}

/**
 * Refuse, and name the alternative in the same breath.
 *
 * The number matters to the model — it has to pick a smaller one or restructure
 * the call — so unlike every other validation message in this layer, this one
 * quotes limits. Safe precisely because they are OUR constants and not the
 * model's input.
 */
function assertTimeoutInBudget(timeoutMs: number): void {
  if (timeoutMs <= EXEC_TIMEOUT_CEILING_MS) return;
  throw new CapabilityError(
    "invalid_input",
    `timeoutMs ${timeoutMs} is above the ${EXEC_TIMEOUT_CEILING_MS}ms ceiling and the command was NOT run. One execution has 20 seconds in total, so a longer exec could not return whatever it found. Use sandbox.spawn and poll it with sandbox.checkProcess instead.`,
  );
}

/**
 * 3000 first and by name, because it is not an out-of-range value — it is a
 * plausible, conventional, correct-looking port that answers for the wrong
 * server. Every other refusal is arithmetic; this one is a warning.
 */
function assertUsablePort(port: number): void {
  if (port === CONTROL_PORT) {
    throw new CapabilityError(
      "invalid_input",
      "port 3000 is the container's own control server: a check against it succeeds whether or not your process is running, so it reports a server that never started. Bind somewhere at 4100 or above — this repo's own apps already claim 3000-3010.",
    );
  }
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new CapabilityError(
      "invalid_input",
      `port ${port} is out of range: it must be a whole number in ${MIN_PORT}-${MAX_PORT}, and 4100 or above is the range to use here.`,
    );
  }
}

/**
 * Keep the beginning and say what was dropped.
 *
 * The marker names both lengths because the model's next move depends on the
 * gap: output that merely stops looks like output that ended, and a build log
 * that "ended" without an error reads as a build that passed.
 */
function clampHead(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return {
    truncated: true,
    text: `${text.slice(0, cap)}\n… truncated: ${cap} of ${text.length} characters shown. Narrow the command (grep, tail, a quieter reporter) rather than running it again unchanged.`,
  };
}

/** The same idea from the other end, for output that is still being produced. */
function clampTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `… earlier output dropped: the last ${cap} of ${text.length} characters follow.\n${text.slice(-cap)}`;
}
