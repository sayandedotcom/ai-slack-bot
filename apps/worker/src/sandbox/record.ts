import { CapabilityError } from "../codemode/errors";
import { sha256Bytes } from "../codemode/effects";
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
 * `ReadableStream` and it goes straight into `R2Bucket.put`. A Worker isolate
 * has a soft memory ceiling in the low hundreds of megabytes; buffering a 50MB
 * video to measure it, and then holding it while R2 writes it, is a spike with
 * no upside. The ceiling is enforced ON THE WAY PAST instead — see
 * `MAX_RECORDING_BYTES`.
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

/** The single-frame contract with `record-harness.cjs`. */
type HarnessResult = {
  state: "passed" | "failed" | "browser-unavailable";
  error: string | null;
  video: string | null;
  /** The mp4's real size, statted by the harness immediately before it
   *  reported. Null whenever `video` is null — and treated as null when a
   *  harness predating the field omits it, which downgrades the truncation
   *  check to "unavailable" rather than breaking the publish. */
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
  writeFile(path: string, content: string): Promise<unknown>;
  startProcess(
    command: string,
    options?: { processId?: string; autoCleanup?: boolean; cwd?: string },
  ): Promise<{ id: string }>;
  getProcess(id: string): Promise<RecordProcessSnapshot | null>;
  getProcessLogs(id: string): Promise<{ stdout: string; stderr: string }>;
  /** Raw bytes, streamed. Never buffered on this side. */
  readBinary(path: string): Promise<ReadableStream<Uint8Array>>;
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
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as Partial<HarnessResult>;
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
        video: typeof parsed.video === "string" && parsed.video.length > 0 ? parsed.video : null,
        bytes:
          typeof parsed.bytes === "number" && Number.isInteger(parsed.bytes) && parsed.bytes >= 0
            ? parsed.bytes
            : null,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      };
    } catch {
      // A truncated or interleaved line is not the result; keep looking back.
      continue;
    }
  }
  return null;
}

function startedAtMs(startTime: Date | string): number {
  const parsed = startTime instanceof Date ? startTime.getTime() : Date.parse(startTime);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  input: { script: string; label: string; timeoutMs?: number },
): Promise<{ recordingId: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_RECORDING_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RECORDING_TIMEOUT_MS) {
    throw new CapabilityError(
      "invalid_input",
      `timeoutMs must be a whole number of milliseconds between 1 and ${MAX_RECORDING_TIMEOUT_MS}, and nothing was recorded. A proof is a short journey through the fix, not a soak test — record the one interaction that demonstrates it.`,
    );
  }

  // A handle, not an effect key: a retried `startRecording` is a second
  // browser, which is what the caller asked for. The UUID is what makes the R2
  // key unguessable, and the slug is what makes the eventual download name
  // meaningful without this module having to remember it.
  const recordingId = `${slugify(input.label)}_${crypto.randomUUID()}`;
  const workdir = workdirFor(recordingId);
  const scriptPath = `${workdir}/script.js`;

  // Creates the directory as a side effect, which is why nothing here runs
  // `mkdir` and why the spawn below passes no `cwd`: every path the harness
  // receives is absolute, so a working directory that did not exist yet cannot
  // wedge the process (lifecycle.ts has seen exactly that failure).
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
    },
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
  recordingId: string,
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

  const logs = await deps.getProcessLogs(recordingId);
  // REDACTED FIRST, BOUNDED SECOND, never the other way round. Cutting first
  // can leave the head of a dev-env value in the kept half and its tail in the
  // dropped half, which defeats the scrub while looking like it worked — the
  // same ordering rule `codemode/bindings/sandbox.ts` states for exec output.
  const stdoutTail = clampTail(redact(scriptOutput(logs.stdout)), RECORDING_TAIL_CHARS);
  const elapsedMs = Math.max(0, now() - startedAtMs(process.startTime));

  if (process.status === "starting" || process.status === "running") {
    return { state: "running", url: null, error: null, stdoutTail, durationMs: elapsedMs };
  }

  const result = parseResult(logs.stdout);
  if (result === null) {
    // The harness died before it could report. Its stderr is the only thing
    // that explains why, and an exit code without it is unactionable.
    const stderr = clampTail(redact(logs.stderr), RECORDING_ERROR_CHARS).trim();
    return {
      state: "failed",
      url: null,
      error: `the recording harness exited with code ${process.exitCode ?? "unknown"} without reporting a result, so no video was produced.${stderr.length === 0 ? "" : ` Last error output: ${stderr}`}`,
      stdoutTail,
      durationMs: elapsedMs,
    };
  }

  // "browser-unavailable" is not a state the model can act on, and the
  // harness's own sentence is — it names the missing binary and the command
  // that installs it. Preserved verbatim rather than replaced with a summary.
  const state: RecordingStatus["state"] = result.state === "passed" ? "passed" : "failed";
  const published =
    result.video === null ? null : await publish(deps, recordingId, result.video, result.bytes);

  // BOUNDED PER PART, NOT ACROSS THE JOIN. The harness's error can be 2000
  // characters on its own, and a single `slice` over the joined string would
  // then drop the publish problem entirely — which is the half this module
  // wrote, the half that is actionable, and the half that explains why there is
  // no URL. Our own problem sentences are short and bounded by construction.
  //
  // Redacted before either is bounded, for the reason stated above `stdoutTail`.
  const reasons = [
    result.error === null ? null : clampHead(redact(result.error), RECORDING_ERROR_CHARS),
    published?.problem ?? null,
  ].filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0);

  return {
    state,
    url: published?.url ?? null,
    error: reasons.length === 0 ? null : reasons.join("\n\n"),
    stdoutTail,
    durationMs: result.durationMs > 0 ? result.durationMs : elapsedMs,
  };
}

/**
 * Eight mebibytes: the size of the ONE buffer a publish ever holds.
 *
 * WHY MULTIPART AT ALL. `R2Bucket.put` refuses a stream whose length it does
 * not know — "Provided readable stream must have a known length (request/
 * response body or readable half of FixedLengthStream)" — and the length of a
 * video is exactly what the Worker does not have as bytes arrive: the harness
 * reports a PATH, and draining the file to measure it is the memory spike this
 * whole path exists to avoid. A multipart upload is how bytes of not-yet-known
 * total length reach R2.
 *
 * WHAT THE MEMORY BOUND ACTUALLY IS, stated precisely because a number in a
 * comment that the code does not honour is worse than no number. Bytes are
 * copied straight into a part-sized buffer as they arrive, and that buffer is
 * handed to `uploadPart` and dropped from this frame BEFORE the await, with the
 * next one allocated lazily afterwards. So what is live across an upload is one
 * `PART_BYTES` buffer plus the current stream chunk (tens of kilobytes) — one
 * part, not three. An earlier draft concatenated the held chunks and then
 * sliced the part out of the result, which kept the chunks, the concatenation
 * and the slice all live at once: ~3x. That is why this reads as a copy loop
 * rather than a concat.
 *
 * WHY THIS SIZE. R2 requires every part except the last to be the same size and
 * at least 5MiB, so the floor is not a choice; 8MiB means a typical 3-6MB proof
 * never becomes a multipart upload at all (one `put`, one round trip) while a
 * 50MB one is seven parts.
 */
const PART_BYTES = 8 * 1024 * 1024;

/**
 * Container to R2, a part at a time, with the ceiling enforced on the way past.
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
  videoPath: string,
  expectedBytes: number | null,
): Promise<{ url: string | null; problem: string | null }> {
  const key = await proofKeyFor(recordingId);
  const url = `${deps.proofsBaseUrl}/${key.slice(PROOF_KEY_PREFIX.length)}`;
  const label = labelOf(recordingId);
  const options = {
    httpMetadata: {
      contentType: "video/mp4",
      // Stored for completeness; the route re-derives both of these rather than
      // echoing metadata back to a browser.
      contentDisposition: `inline; filename="${label}.mp4"`,
    },
    customMetadata: { label, recordedAt: new Date().toISOString() },
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  /** Exactly `PART_BYTES` when allocated; null between parts, so it is not
   *  live across an `uploadPart` await. */
  let part: Uint8Array | null = null;
  let partLen = 0;
  let total = 0;
  /** Whether anything was actually sent, so a failure BEFORE the first write
   *  cannot delete an object a previous poll published. */
  let wrote = false;

  /** Undo everything, so a refusal never leaves half a proof behind. */
  const unwind = async (): Promise<void> => {
    if (reader !== null) await reader.cancel().catch(() => {});
    if (upload !== null) await upload.abort().catch(() => {});
  };

  /** Refuse readably, having cleaned up first. */
  const refuse = async (problem: string): Promise<{ url: null; problem: string }> => {
    await unwind();
    return { url: null, problem };
  };

  try {
    // Already there: this is a poll, not a first sight. `head` costs one
    // metadata read against re-uploading tens of megabytes on every turn.
    if ((await deps.bucket.head(key)) !== null) return { url, problem: null };

    reader = (await deps.readBinary(videoPath)).getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > MAX_RECORDING_BYTES) {
        // The ceiling as a valve rather than a check, and it fires BEFORE the
        // part that would carry the excess is uploaded.
        return await refuse(
          `the recording is larger than the ${MAX_RECORDING_BYTES} byte ceiling, so it was NOT published and there is no URL to share. Record a shorter interaction: a proof is the one journey that demonstrates the fix, not the whole session.`,
        );
      }

      // Copied into the part buffer rather than held as a list of chunks — see
      // the memory note on PART_BYTES.
      let offset = 0;
      while (offset < value.byteLength) {
        part ??= new Uint8Array(PART_BYTES);
        const take = Math.min(PART_BYTES - partLen, value.byteLength - offset);
        part.set(value.subarray(offset, offset + take), partLen);
        partLen += take;
        offset += take;

        if (partLen === PART_BYTES) {
          const full = part;
          // Dropped from this frame BEFORE the await, and reallocated lazily
          // on the next chunk, so only one part-sized buffer is ever live.
          part = null;
          partLen = 0;
          upload ??= await deps.bucket.createMultipartUpload(key, options);
          wrote = true;
          parts.push(await upload.uploadPart(parts.length + 1, full));
        }
      }
    }

    if (total === 0) {
      return await refuse(
        "the recording harness reported a video file that turned out to be empty, so there is nothing to share. The browser most likely closed before the page painted; record the interaction again.",
      );
    }

    // THE TRUNCATION GUARD, and the reason the harness reports `bytes` at all.
    //
    // A read that ERRORS is caught below and cleaned up. A read that simply
    // ends early — a torn-down container, an RPC frame lost, a transport that
    // signals `done` on an incomplete body — looks identical to a complete one
    // from here: no exception, a shorter object, a clean `complete()`, and a
    // URL reported as proof. The resulting file uploads, resolves, and plays
    // for a few seconds before stopping. Nothing downstream could detect it;
    // a human clicking the link in a customer thread would. So the length the
    // harness statted is compared against the length actually received, and a
    // mismatch is refused in the same readable style as the ceiling.
    if (expectedBytes !== null && total !== expectedBytes) {
      return await refuse(
        `the recording was only partly readable: ${total} of ${expectedBytes} bytes arrived before the stream ended, so it was NOT published and there is no URL to share. A partial mp4 plays for a few seconds and then stops, which is worse than no proof at all. Record it again.`,
      );
    }

    if (upload === null) {
      // The common case by far: a proof that fits in one part never becomes a
      // multipart upload. `subarray` rather than a copy — R2 honours the view's
      // bounds, and the tests assert the stored object byte-for-byte.
      wrote = true;
      await deps.bucket.put(
        key,
        (part === null ? new Uint8Array(0) : part.subarray(0, partLen)) as BufferSource,
        options,
      );
    } else {
      if (partLen > 0 && part !== null) {
        wrote = true;
        parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, partLen)));
      }
      await upload.complete(parts);
    }
  } catch (error) {
    await unwind();
    // A single `put` that threw commits nothing, but a delete is one call and
    // the alternative is a half-written proof the route might later serve.
    //
    // GUARDED BY `wrote`, because this block now also covers `head` and
    // `readBinary`. A transient failure reading the bucket must never delete a
    // recording an earlier poll successfully published.
    if (wrote) await deps.bucket.delete(key).catch(() => {});
    return {
      url: null,
      problem: `the recording could not be published, so there is no URL to share (${error instanceof Error ? error.message : "unknown upload failure"}).`,
    };
  }

  return { url, problem: null };
}
