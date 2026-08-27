import { CapabilityError } from "../gateways/errors";
import { sha256Bytes } from "../gateways/hash";
import { makeRedactor } from "./gateway";

/**
 * Phase 19 — the loop closes with a video, not with a claim.
 *
 * The agent can already boot a container, edit the monorepo and run a dev
 * server. What it could not do is SHOW that the fix works: it reported "the
 * checkout button works now" and a human had to take that on trust or
 * reproduce it themselves. This module drives a headless browser through a
 * model-authored script, then moves the resulting mp4 out of the container and
 * into R2 so it can be pasted into a Slack thread and watched.
 *
 * WHY NOT `files.publish` (Phase 09's publisher). That path is deliberately
 * hostile to exactly this payload and every part of that hostility is correct
 * for what it serves: a 5MB cap sized for a base64 round trip through the Code
 * Mode codec, an allowlist with no video type in it, `attachment` disposition
 * so nothing ever renders in the app's origin, and an Access-gated route. A
 * recording is 10-50MB of bytes that must never enter the model's context, and
 * it has to PLAY for someone who does not hold an Access token. Widening the
 * artifact path to fit would have taken away four protections from every
 * artifact to gain one capability. So this is a second, narrow path with its
 * own key space (`proofs/`), its own ceiling, and its own route.
 *
 * WHY THE BYTES NEVER MATERIALISE HERE. `readBinary` hands back a
 * `ReadableStream` AND the file's length, and the stream goes straight into
 * `R2Bucket.put` behind a `FixedLengthStream`. A Worker isolate has a soft
 * memory ceiling in the low hundreds of megabytes; buffering a 50MB video to
 * measure it, and then holding it while R2 writes it, is a spike with no
 * upside. The length is not something this module has to measure — the
 * container's file server reports it — so the ceiling is enforced BEFORE a byte
 * is read; see `MAX_RECORDING_BYTES`.
 *
 * WHY THIS MODULE REMEMBERS NOTHING. `startRecording` and `checkRecording` are
 * separated by model turns and, quite possibly, by isolates: the agent polls
 * across generations, and there is no place to keep a map that survives that.
 * So every fact `checkRecording` needs is derivable from the `recordingId`
 * alone — the process id IS the recording id, the working directory is named
 * after it, and the R2 key is its SHA-256.
 */

/**
 * Fifty mebibytes, on the bytes as they stream past.
 *
 * WHY THIS NUMBER. A 30-second 1280x720 Playwright capture is single-digit
 * megabytes; 50MB is a recording that ran long or a script that looped. Well
 * inside what R2 and the route can serve, and far enough above a real proof
 * that hitting it means something went wrong rather than something went well.
 *
 * WHY REFUSE RATHER THAN TRUNCATE. Half an mp4 is not a shorter video, it is a
 * file no player will open — and it would be served under a URL the agent had
 * already reported as evidence. Refusing is a fact the model can act on
 * ("record a shorter interaction"); a truncated proof is a dead link with a
 * success message attached.
 */
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

/**
 * The same ceiling, as a sentence — the `bytes` figure is the only part that
 * moves, so the wording lives in one place rather than being retyped at each
 * refusal site.
 */
const overCeilingProblem = (bytes: number): string =>
  `the recording is ${bytes} bytes, larger than the ${MAX_RECORDING_BYTES} byte ceiling, so it was NOT published and there is no URL to share. Record a shorter interaction: a proof is the one journey that demonstrates the fix, not the whole session.`;

/** Long enough for a real user journey, short enough to hold a container. */
export const DEFAULT_RECORDING_TIMEOUT_MS = 60_000;

/**
 * Three minutes, REFUSED above rather than clamped.
 *
 * A silent clamp tells the model it has ten minutes, kills the browser at
 * three, and hands back a timeout it will try to debug — the harness looks
 * broken and the real cause is invisible. Same rule as
 * `EXEC_TIMEOUT_CEILING_MS`, and the same reason the message quotes the limit:
 * the number is OURS, and the model's next move depends on it.
 */
export const MAX_RECORDING_TIMEOUT_MS = 180_000;

/** Baked into the image by this phase's Dockerfile task. */
export const RECORDING_HARNESS_PATH = "/usr/local/bin/record-harness.cjs";

/** One directory per recording, named by the id, under the container's tmp. */
export const RECORDING_WORKDIR_ROOT = "/tmp/recordings";

/** Two thousand characters of tail, sized like `PROCESS_TAIL_CHARS`. */
export const RECORDING_TAIL_CHARS = 2_000;

/** An error is read, not skimmed, but it is still not a log file. */
export const RECORDING_ERROR_CHARS = 2_000;

/**
 * A label, reduced to something that is safe as a download filename BY
 * CONSTRUCTION.
 *
 * It travels in two places that both matter: inside the `recordingId` (which is
 * how `checkRecording` recovers it without remembering anything) and in the R2
 * object's `customMetadata`, from which the serving route builds a
 * `content-disposition`. A quote character there would break out of the quoted
 * parameter, so the alphabet is narrowed here and re-checked there rather than
 * trusted across the gap.
 */
export const RECORDING_LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What the harness prints, once, on the line this module reads. */
const RESULT_PREFIX = "RESULT ";

/**
 * The token the model is TOLD to look for, and the sentence that carries it.
 *
 * `browser.record`'s and `browser.checkRecording`'s descriptions both promise
 * that a machine with no Chromium is reported "by name (browser-unavailable)".
 * That promise is only kept if the token survives to `RecordingStatus.error` —
 * the harness's `state` does not, because this module collapses every terminal
 * harness state into `passed`/`failed` (invariant: `state` is the SCRIPT's
 * outcome, not the machine's). So the token has to be IN THE SENTENCE.
 *
 * DEFINED HERE, ONCE, AND ENFORCED HERE. The harness ships inside the container
 * image and cannot import from this tree, so `record.cjs` repeats the same text
 * as a literal with a comment naming this symbol. That copy is the one that can
 * drift — a machine can be running an older image than this Worker — so
 * `checkRecording` does not trust it: if what came back does not carry the
 * token, this sentence is used instead. Tests import this constant rather than
 * retyping a plausible string.
 *
 * WHAT THE INSTRUCTION HAS TO BE. Invariant 6 wants "what happened AND what to
 * do", and "what to do" has to be something the agent can actually do. There is
 * no re-provision method in any namespace, so telling it to re-provision names
 * an action it cannot take and sends it looping. Stopping and reporting is the
 * real move.
 */
export const BROWSER_UNAVAILABLE_TOKEN = "browser-unavailable";

/** The one sentence a browserless machine produces. See the token above. */
export const BROWSER_UNAVAILABLE_MESSAGE = `${BROWSER_UNAVAILABLE_TOKEN}: this run's container never got a working Chromium install (the boot-time install is non-fatal by design). Do not retry; report it and continue without a recording.`;

/** The single-frame contract with `record-harness.cjs`. */
type HarnessResult = {
  state: "passed" | "failed" | "browser-unavailable";
  error: string | null;
  video: string | null;
  /**
   * The mp4's real size, statted by the harness immediately before it reported.
   *
   * NOT LOAD-BEARING ANY MORE, and deliberately still here. `readBinary` now
   * returns the container file server's own `size` on every call, which is
   * authoritative, always present, and known BEFORE a byte is read — so the
   * truncation guard and the ceiling are both enforced against that instead.
   * This field is parsed because the harness already deployed emits it and the
   * wire shape is worth stating in one place; nothing in `publish` consults it.
   */
  bytes: number | null;
  durationMs: number;
};

/**
 * What the agent sees. Pinned: the capability layer and the run transcript both
 * code against these five fields by name.
 */
export type RecordingStatus = {
  state: "running" | "passed" | "failed";
  /** The public /proofs URL, present once terminal AND a video was produced. */
  url: string | null;
  /** Playwright's own error, trimmed; redacted. */
  error: string | null;
  /** Redacted. */
  stdoutTail: string;
  durationMs: number;
};

/** As much of a container process as this module touches. */
export type RecordProcessSnapshot = {
  id: string;
  status: string;
  exitCode?: number;
  /** `Date` over the RPC transport, an ISO string over HTTP. Widened, like
   *  `ProcessSnapshot` in lifecycle.ts, so a transport change cannot make
   *  `durationMs` silently `NaN`. */
  startTime: Date | string;
};

/**
 * Everything this module asks of the world, structurally.
 *
 * Deliberately NOT `SandboxGateway` and deliberately not `Env`. Two reasons,
 * and they pull the same way:
 *
 *  - `SandboxGateway.spawn` hands back an id the container chose, which would
 *    force this module to remember a mapping it has nowhere to keep.
 *    `startProcess` takes the id, so the recording id can BE the process id.
 *  - none of these five primitives needs a credential, and stating them
 *    structurally means a test writes five small functions instead of a
 *    container.
 *
 * `readBinary` is the one that does not exist above: the model-facing
 * `readFile` returns clamped, redacted TEXT, which would destroy an mp4. This
 * is the raw-byte read, wired by the gateway to `readFile(path, { encoding:
 * "none" })`, and it is never reachable from a capability.
 */
export type RecordDeps = {
  /**
   * `mkdir -p`, and the reason `startRecording` has no first-await landmine.
   *
   * The SDK's `writeFile` is a thin POST to the container server's `/api/write`
   * and documents no parent creation; the SDK's own mount code runs `mkdir`
   * before it writes. Assuming otherwise would have made EVERY `record` call
   * die on its first await, looking like a browser problem. So the directory is
   * created, explicitly, and that also guarantees the output directory the
   * harness is handed exists before the harness runs.
   */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(
    command: string,
    options?: { processId?: string; autoCleanup?: boolean; cwd?: string }
  ): Promise<{ id: string }>;
  getProcess(id: string): Promise<RecordProcessSnapshot | null>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  /**
   * Raw bytes, streamed, WITH THE LENGTH THE CONTAINER ALREADY KNOWS.
   *
   * `ReadFileStreamResult` carries `size` next to `content` on every call, so
   * the length is free — and having it is what lets the ceiling be checked
   * before a byte moves and the whole video be published in ONE `put` over a
   * `FixedLengthStream`. Never buffered on this side either way.
   */
  readBinary(
    path: string
  ): Promise<{ content: ReadableStream<Uint8Array>; size: number }>;
  bucket: R2Bucket;
  /** `PROOFS_BASE_URL` — this Worker's own origin plus `/proofs`. */
  proofsBaseUrl: string;
  /** The dev-env VALUES to scrub, exactly as `makeSandboxGateway` scrubs exec
   *  output. A recording script drives a dev server that was handed these. */
  devEnv: Record<string, string>;
  now?: () => number;
};

/**
 * The one prefix a recording is ever written under.
 *
 * Disjoint from published artifacts (bucket root, `<hex>.<ext>`) and from Phase
 * 18's captured diffs (`_internal/`) by construction: a literal here, and the
 * only thing `src/api/proofs.ts` ever prepends.
 */
export const PROOF_KEY_PREFIX = "proofs/";

/** The container directory this recording owns. */
function workdirFor(recordingId: string): string {
  return `${RECORDING_WORKDIR_ROOT}/${recordingId}`;
}

/**
 * The R2 key, and the only thing protecting the recording.
 *
 * The route it is served from is bypassed by Cloudflare Access on purpose (a
 * Slack unfurler carries no Access token), so the key is the secret. SHA-256 of
 * an id that contains a v4 UUID is 122 bits of unguessability behind a one-way
 * function — hashing rather than using the id directly means a recording id
 * that reaches a log or a transcript does not hand over the URL.
 *
 * Under `proofs/`, which keeps this space disjoint from published artifacts
 * (bucket root) and from Phase 18's captured diffs (`_internal/`). It can never
 * be `_internal/`: the prefix is a literal here.
 */
async function proofKeyFor(recordingId: string): Promise<string> {
  const hash = await sha256Bytes(new TextEncoder().encode(recordingId));
  return `${PROOF_KEY_PREFIX}${hash}.mp4`;
}

/** Lowercase, dashed, bounded — or `proof` when nothing survives. */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return RECORDING_LABEL.test(slug) ? slug : "proof";
}

/**
 * The label back out of the id.
 *
 * `<slug>_<uuid>`: the slug's alphabet excludes `_` and a v4 UUID contains
 * none, so the last underscore separates them unambiguously. This is why the
 * label does not have to be stored anywhere `checkRecording` would have to look
 * it up from.
 */
function labelOf(recordingId: string): string {
  const separator = recordingId.lastIndexOf("_");
  if (separator <= 0) return "proof";
  const slug = recordingId.slice(0, separator);
  return RECORDING_LABEL.test(slug) ? slug : "proof";
}

/** Keep the end and say what was dropped — a recording's last line is the one
 *  that explains what it was doing when it stopped. */
function clampTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `... earlier output dropped: the last ${cap} of ${text.length} characters follow.\n${text.slice(-cap)}`;
}

/**
 * Keep the BEGINNING, for an error rather than a log.
 *
 * The opposite end from `clampTail`, and deliberately: a Playwright failure
 * leads with the thing that went wrong ("TimeoutError: locator.click: Timeout
 * 5000ms exceeded") and trails off into stack frames and a DOM snapshot. The
 * first line is the one the model acts on.
 */
function clampHead(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n... error truncated: ${cap} of ${text.length} characters shown.`;
}

/**
 * The script's own output, without the machine protocol line.
 *
 * The RESULT line is a wire format between the harness and this module. Leaving
 * it in the tail invites the model to parse it and to trust a field this module
 * has already decided about — including a `video` path it must never see.
 */
function scriptOutput(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith(RESULT_PREFIX))
    .join("\n");
}

/** The LAST RESULT line, or null when the harness never got that far. */
function parseResult(stdout: string): HarnessResult | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith(RESULT_PREFIX)) continue;
    try {
      const parsed = JSON.parse(
        line.slice(RESULT_PREFIX.length)
      ) as Partial<HarnessResult>;
      if (
        parsed.state !== "passed" &&
        parsed.state !== "failed" &&
        parsed.state !== "browser-unavailable"
      ) {
        return null;
      }
      return {
        state: parsed.state,
        error: typeof parsed.error === "string" ? parsed.error : null,
        video:
          typeof parsed.video === "string" && parsed.video.length > 0
            ? parsed.video
            : null,
        bytes:
          typeof parsed.bytes === "number" &&
          Number.isInteger(parsed.bytes) &&
          parsed.bytes >= 0
            ? parsed.bytes
            : null,
        durationMs:
          typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      };
    } catch {}
  }
  return null;
}

/**
 * When did this process start, and NOW when that cannot be answered.
 *
 * The fallback used to be 0, which is the epoch: a `running` poll on a process
 * whose `startTime` did not parse reported a duration of roughly fifty-four
 * years and told the model its browser had been open since 1970. `now()` makes
 * the same unparseable case read as "just started" — wrong by at most the age
 * of the recording, and never absurd.
 */
function startedAtMs(startTime: Date | string, now: () => number): number {
  const parsed =
    startTime instanceof Date ? startTime.getTime() : Date.parse(startTime);
  return Number.isNaN(parsed) ? now() : parsed;
}

/**
 * Start the browser and hand back a handle.
 *
 * The script is WRITTEN, never passed as an argument: it is model-authored text
 * with quotes, newlines and backticks in it, and a shell command line is the
 * wrong place for all three.
 */
export async function startRecording(
  deps: RecordDeps,
  input: { script: string; label: string; timeoutMs?: number }
): Promise<{ recordingId: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RECORDING_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_RECORDING_TIMEOUT_MS
  ) {
    throw new CapabilityError(
      "invalid_input",
      `timeoutMs must be a whole number of milliseconds between 1 and ${MAX_RECORDING_TIMEOUT_MS}, and nothing was recorded. A proof is a short journey through the fix, not a soak test — record the one interaction that demonstrates it.`
    );
  }

  // A handle, not an effect key: a retried `startRecording` is a second
  // browser, which is what the caller asked for. The UUID is what makes the R2
  // key unguessable, and the slug is what makes the eventual download name
  // meaningful without this module having to remember it.
  const recordingId = `${slugify(input.label)}_${crypto.randomUUID()}`;
  const workdir = workdirFor(recordingId);
  const scriptPath = `${workdir}/script.js`;

  // CREATED, NOT ASSUMED. `writeFile` is a POST to the container's file server
  // and nothing in its contract promises to create missing parents — the SDK's
  // own mount path calls `mkdir` first. This one line is the difference between
  // `record` working and every call dying on its first await with an error that
  // reads like a browser problem. It also guarantees the output directory the
  // harness is handed exists before the harness starts.
  //
  // The spawn below still passes no `cwd`: every path the harness receives is
  // absolute, so a working directory it was never given cannot wedge the
  // process (lifecycle.ts has seen exactly that failure).
  await deps.mkdir(workdir, { recursive: true });
  await deps.writeFile(scriptPath, input.script);

  await deps.startProcess(
    `node ${RECORDING_HARNESS_PATH} ${scriptPath} ${workdir} ${timeoutMs}`,
    {
      // The recording id IS the process id. That is the whole reason
      // `checkRecording` can be stateless across turns and isolates.
      processId: recordingId,
      // WITHOUT THIS the SDK drops the process record on exit, so a finished
      // recording reads as "never started" and its RESULT line is unreachable.
      autoCleanup: false,
    }
  );

  return { recordingId };
}

/**
 * Where is it, and where is the video?
 *
 * Called once per agent turn. Everything expensive is guarded: the object is
 * only uploaded if it is not already there, so a run that polls ten times after
 * finishing uploads once.
 */
export async function checkRecording(
  deps: RecordDeps,
  recordingId: string
): Promise<RecordingStatus> {
  const now = deps.now ?? Date.now;
  const redact = makeRedactor(deps.devEnv);

  const process = await deps.getProcess(recordingId);
  if (process === null) {
    // Terminal, deliberately. "Still running" is the one answer that costs the
    // agent every remaining turn, and a container that was torn down forgets
    // every process it had.
    return {
      state: "failed",
      url: null,
      error:
        "no recording with that id is known to this run's container. Use the recordingId startRecording returned; a container that was torn down forgets every process it had, and the recording has to be started again.",
      stdoutTail: "",
      durationMs: 0,
    };
  }

  let logs = await deps.getProcessLogs(recordingId);
  const elapsedMs = Math.max(0, now() - startedAtMs(process.startTime, now));

  if (process.status === "starting" || process.status === "running") {
    // REDACTED FIRST, BOUNDED SECOND, never the other way round. Cutting first
    // can leave the head of a dev-env value in the kept half and its tail in
    // the dropped half, which defeats the scrub while looking like it worked —
    // the same ordering rule `codemode/bindings/sandbox.ts` states for exec
    // output.
    return {
      state: "running",
      url: null,
      error: null,
      stdoutTail: clampTail(
        redact(scriptOutput(logs.stdout)),
        RECORDING_TAIL_CHARS
      ),
      durationMs: elapsedMs,
    };
  }

  let result = parseResult(logs.stdout);
  if (result === null && (process.exitCode ?? -1) === 0) {
    // A CLEAN EXIT WITH NO RESULT LINE IS A RACE, NOT A CRASH — and it is a
    // race this harness deliberately created. `emit()` sets `process.exitCode`
    // instead of calling `process.exit()` precisely so stdout drains naturally
    // rather than being cut off mid-write; the cost of that choice is a window
    // where the process is already reported "completed" and the last line has
    // not landed in the log buffer yet. Declaring failure here throws away a
    // recording that SUCCEEDED. So the logs are read once more before the
    // refusal below is built. A nonzero exit gets no second read: that is a
    // real crash, and its stderr is already the answer.
    logs = await deps.getProcessLogs(recordingId);
    result = parseResult(logs.stdout);
  }

  const stdoutTail = clampTail(
    redact(scriptOutput(logs.stdout)),
    RECORDING_TAIL_CHARS
  );

  if (result === null) {
    // The harness died before it could report. Its stderr is the only thing
    // that explains why, and an exit code without it is unactionable.
    const stderr = clampTail(redact(logs.stderr), RECORDING_ERROR_CHARS).trim();
    const exited =
      (process.exitCode ?? -1) === 0
        ? "the recording harness exited cleanly (code 0) but its result line never reached the log, even on a second read, so no video can be published"
        : `the recording harness exited with code ${process.exitCode ?? "unknown"} without reporting a result, so no video was produced`;
    return {
      state: "failed",
      url: null,
      error: `${exited}.${stderr.length === 0 ? "" : ` Last error output: ${stderr}`}`,
      stdoutTail,
      durationMs: elapsedMs,
    };
  }

  // "browser-unavailable" is a STATE, and this module collapses states — the
  // model only ever sees "passed" or "failed", because `state` reports the
  // script's outcome and a missing browser is not one. The token therefore has
  // to survive inside the SENTENCE, which is what the `browser` namespace's
  // descriptions promise the model it can look for. `BROWSER_UNAVAILABLE_MESSAGE`
  // is the canonical wording and it is substituted whenever the harness's own
  // message does not already carry the token — an older image is a real
  // possibility, and the promise in the .d.ts must hold against one.
  const state: RecordingStatus["state"] =
    result.state === "passed" ? "passed" : "failed";
  const harnessError =
    result.state === "browser-unavailable" &&
    !(result.error ?? "").includes(BROWSER_UNAVAILABLE_TOKEN)
      ? BROWSER_UNAVAILABLE_MESSAGE
      : result.error;
  const published =
    result.video === null
      ? null
      : await publish(deps, recordingId, result.video);

  // BOUNDED PER PART, NOT ACROSS THE JOIN. The harness's error can be 2000
  // characters on its own, and a single `slice` over the joined string would
  // then drop the publish problem entirely — which is the half this module
  // wrote, the half that is actionable, and the half that explains why there is
  // no URL. Our own problem sentences are short and bounded by construction,
  // EXCEPT the one that embeds a caught exception's message (a `head()` or
  // `readBinary()` failure against a torn-down container) — `publish` redacts
  // and bounds that piece itself, at the point it is built, so no path out of
  // this module can carry an unredacted or unbounded value.
  //
  // `harnessError` is redacted before it is bounded, for the reason stated
  // above `stdoutTail`; `published.problem` arrives already redacted.
  const reasons = [
    harnessError === null
      ? null
      : clampHead(redact(harnessError), RECORDING_ERROR_CHARS),
    published?.problem ?? null,
  ].filter(
    (reason): reason is string =>
      typeof reason === "string" && reason.trim().length > 0
  );

  return {
    state,
    url: published?.url ?? null,
    error: reasons.length === 0 ? null : reasons.join("\n\n"),
    stdoutTail,
    durationMs: result.durationMs > 0 ? result.durationMs : elapsedMs,
  };
}

/**
 * Container to R2, in ONE call, with the ceiling enforced before a byte moves.
 *
 * WHY THERE IS NO MULTIPART UPLOAD HERE ANY MORE. `R2Bucket.put` refuses a
 * stream whose length it does not know — "Provided readable stream must have a
 * known length (request/response body or readable half of FixedLengthStream)".
 * An earlier draft concluded that the Worker could not know a recording's
 * length as bytes arrived and paid for that with ~120 lines of part-buffering.
 * It was not true: `readFile(path, { encoding: "none" })` answers with
 * `ReadFileStreamResult`, whose `size` is the file's length, on every call and
 * before any byte is read. So the length is free, `FixedLengthStream` is the
 * whole mechanism, and the upload is one atomic `put`.
 *
 * That also removes a real failure mode rather than only lines. A multipart
 * upload spanned many awaits inside a single `checkRecording` poll; an
 * execution cut in the middle of it ran neither the cleanup nor the catch, so
 * `abort()` never fired, R2 kept an incomplete upload, the next poll's `head()`
 * still answered null, and the poll after that started another one. Repeated
 * polls on a large video accumulated orphaned uploads and never published. One
 * `put` has nothing to orphan.
 *
 * THE TRUNCATION GUARD IS NOW A PROPERTY OF THE STREAM, not a comparison after
 * the fact. A read that simply ENDS EARLY — a torn-down container, a lost RPC
 * frame — is indistinguishable from a complete one at the reading end: no
 * exception, a shorter object, a clean upload, and a URL reported as proof that
 * plays for a few seconds and stops. `FixedLengthStream(size)` makes that
 * arithmetic R2's problem: fewer bytes than declared and the `put` itself
 * fails, which lands in the catch below and is reported as a publish problem.
 *
 * THIS FUNCTION DOES NOT THROW, and that is a contract rather than an
 * accident. It is called from the middle of a poll that has already collected
 * the harness's verdict, the error the model has to act on and the tail of its
 * output; an exception escaping here would throw all of that away and turn a
 * routine poll into a capability failure. The container being torn down between
 * the RESULT line and the poll is not exotic — it is what happens when a run
 * ends — so every await, `head` and `readBinary` included, is inside the `try`.
 *
 * The returned `problem` is therefore a sentence for the model, never an
 * exception: a publish that failed does not change whether the browser journey
 * passed, and reporting "failed" because an upload was too big would tell the
 * agent to go and fix code that is working.
 */
async function publish(
  deps: RecordDeps,
  recordingId: string,
  videoPath: string
): Promise<{ url: string | null; problem: string | null }> {
  const key = await proofKeyFor(recordingId);
  const url = `${deps.proofsBaseUrl}/${key.slice(PROOF_KEY_PREFIX.length)}`;
  const label = labelOf(recordingId);
  // This catch block covers `head()` and `readBinary()` failures against a
  // torn-down container as well as upload failures, so the exception message
  // below can carry content from the sandbox side — the same class of value
  // `stdoutTail` and the harness error are scrubbed for. Built here, not in
  // `checkRecording`, so nothing downstream of `publish` can forward an
  // unredacted `problem`.
  const redact = makeRedactor(deps.devEnv);

  /** Whether anything was actually sent, so a failure BEFORE the write cannot
   *  delete an object a previous poll published. */
  let wrote = false;

  try {
    // Already there: this is a poll, not a first sight. `head` costs one
    // metadata read against re-uploading tens of megabytes on every turn.
    if ((await deps.bucket.head(key)) !== null) return { url, problem: null };

    const { content, size } = await deps.readBinary(videoPath);

    /** Refuse readably, letting go of the stream we are not going to send. */
    const refuse = async (
      problem: string
    ): Promise<{ url: null; problem: string }> => {
      await content.cancel().catch(() => {});
      return { url: null, problem };
    };

    // BEFORE A BYTE IS READ. The container told us how big the file is, so a
    // 50MB refusal costs one metadata round trip instead of 50MB of transfer.
    if (size > MAX_RECORDING_BYTES)
      return await refuse(overCeilingProblem(size));

    if (size === 0) {
      return await refuse(
        "the recording harness reported a video file that turned out to be empty, so there is nothing to share. The browser most likely closed before the page painted; record the interaction again."
      );
    }

    wrote = true;
    // ONE ATOMIC CALL, and the bytes never materialise in this isolate:
    // `FixedLengthStream` gives `put` the known length it demands while the
    // stream stays a stream. `test/api-proofs.test.ts` uses the same pattern to
    // write an over-ceiling fixture without holding 50MB.
    await deps.bucket.put(
      key,
      content.pipeThrough(new FixedLengthStream(size)),
      {
        httpMetadata: {
          contentType: "video/mp4",
          // Stored for completeness; the route re-derives both of these rather
          // than echoing metadata back to a browser.
          contentDisposition: `inline; filename="${label}.mp4"`,
        },
        customMetadata: { label, recordedAt: new Date().toISOString() },
      }
    );
  } catch (error) {
    // A `put` that threw commits nothing, but a delete is one call and the
    // alternative is a half-written proof the route might later serve.
    //
    // GUARDED BY `wrote`, because this block also covers `head` and
    // `readBinary`. A transient failure reading the bucket must never delete a
    // recording an earlier poll successfully published.
    if (wrote) await deps.bucket.delete(key).catch(() => {});
    const message =
      error instanceof Error ? error.message : "unknown upload failure";
    return {
      url: null,
      // REDACTED, THEN BOUNDED — same order as `stdoutTail` and the harness
      // error, and for the same reason. Only the embedded exception message
      // is capped; the wrapping sentence (the actionable "there is no URL to
      // share") is never sliced away, matching the rule `reasons` in
      // `checkRecording` already follows for the harness error.
      problem: `the recording could not be published, so there is no URL to share (${clampHead(redact(message), RECORDING_ERROR_CHARS)}). A recording that only partly transferred is refused rather than published: a partial mp4 plays for a few seconds and then stops, which is worse than no proof at all.`,
    };
  }

  return { url, problem: null };
}
