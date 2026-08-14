import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BROWSER_UNAVAILABLE_MESSAGE,
  BROWSER_UNAVAILABLE_TOKEN,
  checkRecording,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_TIMEOUT_MS,
  RECORDING_ERROR_CHARS,
  RECORDING_HARNESS_PATH,
  RECORDING_TAIL_CHARS,
  RECORDING_WORKDIR_ROOT,
  startRecording,
  type RecordDeps,
} from "../src/sandbox/record";
import { isInternalKey } from "../src/sandbox/diff";

/**
 * THE RECORDING IS THE PROOF, AND IT HAS TO SURVIVE THE TRIP.
 *
 * Everything here is about the seam between a container that produced an mp4
 * and an R2 object a human can click. Three properties are load-bearing and
 * each has cases of its own:
 *
 *  - the bytes go container → R2 as a STREAM. A 50MB `arrayBuffer()` in a
 *    Worker is a memory spike with no upside, and the ceiling is enforced on
 *    the way past rather than after the fact.
 *  - the key is unguessable and is NEVER under `_internal/`. The URL is served
 *    from a route that Cloudflare Access bypasses, so the key is the only
 *    secret protecting the recording.
 *  - dev-env VALUES never reach `stdoutTail` or `error`. A recording script is
 *    model-authored and runs against a dev server that was handed the app's
 *    dev-tier environment; the same scrub Phase 18 applies to exec output
 *    applies here, for the same reason.
 */

const BASE = "https://firefighter.example/proofs";

type StubProcess = {
  status: string;
  exitCode?: number;
  startTime: Date;
  stdout: string;
  stderr: string;
};

type HarnessResult = {
  state: "passed" | "failed" | "browser-unavailable";
  error: string | null;
  video: string | null;
  /** The mp4's real size, statted by the harness right before it reported. */
  bytes: number | null;
  durationMs: number;
};

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/**
 * A stream that fails the test if anything ever pulls from it.
 *
 * The ceiling is now decided from the length the container reports, before a
 * byte moves, so "no byte was read" is the property — not "the refusal happened
 * partway through". A 50MB fixture would prove the opposite of what is wanted.
 */
function unreadableStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("the publisher read bytes it had already been told to refuse");
    },
  });
}

function stub(
  options: {
    video?: Uint8Array | ReadableStream<Uint8Array>;
    /** What the container claims the file's length is. Defaults to the real
     *  length of `video`; set it apart to model a transfer that ends early. */
    size?: number;
    devEnv?: Record<string, string>;
    bucket?: R2Bucket;
    now?: () => number;
  } = {},
) {
  const files = new Map<string, string>();
  const spawns: Array<{ command: string; options?: { processId?: string; cwd?: string } }> = [];
  const processes = new Map<string, StubProcess>();
  const reads: string[] = [];
  /** Every container file operation, in order — `mkdir` must precede the
   *  write, or the write lands in a directory nothing created. */
  const fileOps: string[] = [];

  const deps: RecordDeps = {
    async mkdir(path, mkdirOptions) {
      fileOps.push(`mkdir ${path} recursive=${String(mkdirOptions.recursive)}`);
      return { success: true };
    },
    async writeFile(path, content) {
      fileOps.push(`writeFile ${path}`);
      files.set(path, content);
      return { success: true };
    },
    async startProcess(command, opts) {
      spawns.push({ command, options: opts });
      const id = opts?.processId ?? `process-${spawns.length}`;
      processes.set(id, {
        status: "running",
        startTime: new Date(1_000),
        stdout: "",
        stderr: "",
      });
      return { id };
    },
    async getProcess(id) {
      const process = processes.get(id);
      return process === undefined ? null : { id, ...process };
    },
    async getProcessLogs(id) {
      const process = processes.get(id);
      return { stdout: process?.stdout ?? "", stderr: process?.stderr ?? "" };
    },
    async readBinary(path) {
      reads.push(path);
      const video = options.video;
      if (video === undefined) throw new Error(`no such file: ${path}`);
      // `size` alongside `content`, exactly as the container's file server
      // reports it: authoritative, free, and known before a byte is read.
      return {
        content: video instanceof ReadableStream ? video : streamOf(video),
        size: options.size ?? (video instanceof ReadableStream ? 0 : video.byteLength),
      };
    },
    bucket: options.bucket ?? env.ARTIFACTS,
    proofsBaseUrl: BASE,
    devEnv: options.devEnv ?? {},
    now: options.now ?? (() => 9_000),
  };

  /** Drive the stubbed process to its terminal state with a harness RESULT line. */
  const finish = (
    recordingId: string,
    result: Partial<HarnessResult>,
    extra?: { stdout?: string; stderr?: string; exitCode?: number },
  ): void => {
    const process = processes.get(recordingId)!;
    const line = `RESULT ${JSON.stringify({
      state: "passed",
      error: null,
      video: `${RECORDING_WORKDIR_ROOT}/${recordingId}/video.mp4`,
      // The default matches the stub's default video exactly, so the
      // truncation guard is satisfied unless a case deliberately breaks it.
      bytes: MP4.byteLength,
      durationMs: 4_200,
      ...result,
    } satisfies HarnessResult)}`;
    processes.set(recordingId, {
      ...process,
      status: "completed",
      exitCode: extra?.exitCode ?? 0,
      stdout: `${extra?.stdout ?? "running the script\n"}${line}\n`,
      stderr: extra?.stderr ?? "",
    });
  };

  /** Terminate without ever printing a RESULT line — a harness that died. */
  const crash = (recordingId: string, stderr: string, exitCode = 1): void => {
    const process = processes.get(recordingId)!;
    processes.set(recordingId, { ...process, status: "completed", exitCode, stderr });
  };

  return { deps, files, fileOps, spawns, processes, reads, finish, crash };
}

const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

/** The key the URL names, for reading the object back out of the bucket. */
const keyOf = (url: string): string => `proofs/${url.slice(`${BASE}/`.length)}`;

describe("startRecording writes the script and spawns the harness", () => {
  it("creates the recording's directory BEFORE writing the script into it", async () => {
    // `writeFile` is a POST to the container's file server and creates no
    // parents — the SDK's own mount path calls `mkdir` first. Without this the
    // very first await of every `record` call fails, and the model reads the
    // resulting error as a browser problem.
    const { deps, fileOps } = stub({ video: MP4 });

    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });

    const workdir = `${RECORDING_WORKDIR_ROOT}/${recordingId}`;
    expect(fileOps).toEqual([
      `mkdir ${workdir} recursive=true`,
      `writeFile ${workdir}/script.js`,
    ]);
  });

  it("puts the model's script at <workdir>/script.js and never passes it as an argument", async () => {
    const { deps, files, spawns } = stub({ video: MP4 });
    const script = "await page.goto('http://localhost:4100');";

    const { recordingId } = await startRecording(deps, { script, label: "Checkout flow" });

    const workdir = `${RECORDING_WORKDIR_ROOT}/${recordingId}`;
    expect(files.get(`${workdir}/script.js`)).toBe(script);
    // A script on the command line is a quoting bug waiting to happen, and the
    // script is model-authored text.
    expect(spawns[0]!.command).not.toContain("page.goto");
  });

  it("spawns the pinned harness with scriptPath, outDir and the timeout, keyed by the recordingId", async () => {
    const { deps, spawns } = stub({ video: MP4 });

    const { recordingId } = await startRecording(deps, {
      script: "x",
      label: "checkout",
      timeoutMs: 45_000,
    });

    const workdir = `${RECORDING_WORKDIR_ROOT}/${recordingId}`;
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe(
      `node ${RECORDING_HARNESS_PATH} ${workdir}/script.js ${workdir} 45000`,
    );
    // The process id IS the recording id, which is what lets `checkRecording`
    // find the run again without this module remembering anything.
    expect(spawns[0]!.options?.processId).toBe(recordingId);
  });

  it("defaults the timeout and refuses one above the ceiling rather than clamping it", async () => {
    const { deps, spawns } = stub({ video: MP4 });

    await startRecording(deps, { script: "x", label: "checkout" });
    expect(spawns[0]!.command.endsWith(" 60000")).toBe(true);

    // Clamping would tell the model it had three minutes, kill the browser at
    // one, and hand back a failure it would try to debug.
    await expect(
      startRecording(deps, { script: "x", label: "checkout", timeoutMs: 600_000 }),
    ).rejects.toThrow(new RegExp(String(MAX_RECORDING_TIMEOUT_MS)));
    expect(spawns).toHaveLength(1);
  });
});

describe("a passing run publishes the video and hands back a public URL", () => {
  it("streams the mp4 into R2 and returns the /proofs URL for it", async () => {
    const { deps, finish, reads } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("passed");
    expect(status.error).toBeNull();
    expect(status.durationMs).toBe(4_200);
    expect(status.url).toMatch(new RegExp(`^${BASE}/[0-9a-f]{64}\\.mp4$`));

    // The bytes the harness produced are the bytes in the bucket.
    expect(reads).toEqual([`${RECORDING_WORKDIR_ROOT}/${recordingId}/video.mp4`]);
    const object = await env.ARTIFACTS.get(keyOf(status.url!));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(MP4);
    expect(object!.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("keys the object unguessably, under proofs/ and never under _internal/", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const status = await checkRecording(deps, recordingId);
    const key = keyOf(status.url!);

    // `proofs/` keeps the space disjoint from published artifacts, and 64 hex
    // characters of SHA-256 over a v4 UUID is the only thing protecting a
    // recording served from an Access-BYPASSED route.
    expect(key).toMatch(/^proofs\/[0-9a-f]{64}\.mp4$/);
    expect(isInternalKey(key)).toBe(false);
    expect(key).not.toContain("_internal");
    // It must not be derivable from anything the requester can see.
    expect(key).not.toContain(recordingId);
  });

  it("gives two recordings of the same label two different keys", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const first = await startRecording(deps, { script: "x", label: "checkout" });
    const second = await startRecording(deps, { script: "x", label: "checkout" });
    finish(first.recordingId, {});
    finish(second.recordingId, {});

    const a = await checkRecording(deps, first.recordingId);
    const b = await checkRecording(deps, second.recordingId);
    expect(a.url).not.toBe(b.url);
  });

  it("publishes once, however many times it is polled", async () => {
    let puts = 0;
    const bucket = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property !== "put") return bound;
        return (...args: unknown[]) => {
          puts += 1;
          return bound(...args);
        };
      },
    }) as R2Bucket;

    const { deps, finish } = stub({ video: MP4, bucket });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {});

    const first = await checkRecording(deps, recordingId);
    const second = await checkRecording(deps, recordingId);

    // Polling is the interface: the agent calls this every turn until it is
    // terminal, and re-uploading the video on each poll would spend a
    // container's egress on an object that is already there.
    expect(second.url).toBe(first.url);
    expect(puts).toBe(1);
  });
});

describe("a failing run publishes the video AND surfaces the error", () => {
  it("keeps both halves: the failure the model must act on and the evidence a human watches", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {
      state: "failed",
      error: "TimeoutError: locator.click: Timeout 5000ms exceeded.",
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("failed");
    // The video of a FAILING run is the most valuable one there is — it shows
    // what the page actually did. Dropping it because the assertion failed
    // would throw away the whole point of recording.
    expect(status.url).not.toBeNull();
    expect(status.error).toContain("TimeoutError");
    expect(await env.ARTIFACTS.head(keyOf(status.url!))).not.toBeNull();
  });

  it("surfaces browser-unavailable as a failure carrying the token the model is told to look for", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {
      state: "browser-unavailable",
      error: BROWSER_UNAVAILABLE_MESSAGE,
      video: null,
      bytes: null,
    });

    const status = await checkRecording(deps, recordingId);

    // THE STATE IS DISCARDED — this module reports the SCRIPT's outcome, so
    // "browser-unavailable" collapses to "failed" before the model sees it.
    // The `browser` namespace's description promises the model the name
    // `browser-unavailable`, so the only place that promise can be kept is the
    // sentence. Asserted against the exported constant, not a retyped string.
    expect(status.state).toBe("failed");
    expect(status.error).toContain(BROWSER_UNAVAILABLE_TOKEN);
    expect(status.error).toContain(BROWSER_UNAVAILABLE_MESSAGE);
    expect(status.url).toBeNull();
  });

  it("names an action the agent can take, and never one it cannot", async () => {
    // There is no re-provision method in any namespace. A message telling the
    // model to re-provision names a capability it does not have, so it loops
    // or invents one; invariant 6 asks for what happened AND what to do.
    expect(BROWSER_UNAVAILABLE_MESSAGE).toMatch(/do not retry/i);
    expect(BROWSER_UNAVAILABLE_MESSAGE).not.toMatch(/re-?provision/i);
    expect(BROWSER_UNAVAILABLE_MESSAGE).not.toMatch(/playwright install/i);
  });

  it("substitutes the canonical sentence when an older harness omits the token", async () => {
    // A container can be running an image older than this Worker. The .d.ts's
    // promise has to hold against one, so the token is enforced here rather
    // than trusted from across the boundary.
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {
      state: "browser-unavailable",
      error: "the boot-time Chromium install did not complete on this machine",
      video: null,
      bytes: null,
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("failed");
    expect(status.error).toBe(BROWSER_UNAVAILABLE_MESSAGE);
  });

  it("reports a harness that died without a RESULT line, naming the exit code", async () => {
    const { deps, crash } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    crash(recordingId, "node: cannot find module '/usr/local/bin/record-harness.cjs'\n", 127);

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("failed");
    expect(status.url).toBeNull();
    expect(status.error).toContain("127");
    expect(status.error).toContain("cannot find module");
  });

  it("re-reads the logs once when a clean exit has no RESULT line, and publishes what it finds", async () => {
    // EXIT 0 WITH NO RESULT IS A LOG-FLUSH RACE, NOT A CRASH. The harness sets
    // `process.exitCode` rather than calling `process.exit` precisely so stdout
    // drains — the cost of that choice is a window where the process reads
    // "completed" and its last line has not landed yet. Treating that as
    // terminal throws away a recording that SUCCEEDED.
    const { deps, processes, recordingId, reads } = await (async () => {
      const s = stub({ video: MP4 });
      const { recordingId: id } = await startRecording(s.deps, { script: "x", label: "checkout" });
      s.processes.set(id, { ...s.processes.get(id)!, status: "completed", exitCode: 0 });
      return { ...s, recordingId: id };
    })();

    let logReads = 0;
    const racing: RecordDeps = {
      ...deps,
      async getProcessLogs(id) {
        logReads += 1;
        // The line lands between the first read and the second, which is
        // exactly the shape of the race.
        if (logReads === 1) return { stdout: "step 1: signed in\n", stderr: "" };
        const line = `RESULT ${JSON.stringify({
          state: "passed",
          error: null,
          video: `${RECORDING_WORKDIR_ROOT}/${id}/video.mp4`,
          bytes: MP4.byteLength,
          durationMs: 4_200,
        })}`;
        return { stdout: `step 1: signed in\n${line}\n`, stderr: "" };
      },
    };

    const status = await checkRecording(racing, recordingId);

    expect(logReads).toBe(2);
    expect(status.state).toBe("passed");
    expect(status.url).not.toBeNull();
    expect(reads).toHaveLength(1);
    expect(processes.get(recordingId)!.exitCode).toBe(0);
  });

  it("gives up after the second read, and says the exit was clean so a human recognises the race", async () => {
    const { deps, processes } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    processes.set(recordingId, {
      ...processes.get(recordingId)!,
      status: "completed",
      exitCode: 0,
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/exited cleanly \(code 0\)/);
    expect(status.error).toMatch(/second read/);
  });

  it("does not re-read the logs for a nonzero exit, which is a real crash", async () => {
    const { deps, crash } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    crash(recordingId, "segfault\n", 139);

    let logReads = 0;
    const counted: RecordDeps = {
      ...deps,
      async getProcessLogs(id) {
        logReads += 1;
        return deps.getProcessLogs(id);
      },
    };

    const status = await checkRecording(counted, recordingId);

    expect(logReads).toBe(1);
    expect(status.error).toContain("139");
  });

  it("reports an id the container has never heard of as a failure, not a hang", async () => {
    const { deps } = stub({ video: MP4 });
    const status = await checkRecording(deps, "checkout_00000000-0000-4000-8000-000000000000");

    // "running forever" is the one answer that costs the agent every remaining
    // turn, so an unknown id must be terminal.
    expect(status.state).toBe("failed");
    expect(status.url).toBeNull();
    expect(status.error).toMatch(/no recording/i);
  });
});

describe("a run still in the browser is running", () => {
  it("reports running with no URL and the elapsed time so far", async () => {
    const { deps } = stub({ video: MP4, now: () => 12_000 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });

    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("running");
    expect(status.url).toBeNull();
    expect(status.error).toBeNull();
    // The stub starts every process at t=1000.
    expect(status.durationMs).toBe(11_000);
  });

  it("shows the script's own output while it runs, without the machine protocol line", async () => {
    const { deps, processes } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    processes.set(recordingId, {
      ...processes.get(recordingId)!,
      stdout: "step 1: signed in\nstep 2: added to cart\n",
    });

    const status = await checkRecording(deps, recordingId);
    expect(status.stdoutTail).toContain("step 2: added to cart");
  });

  it("keeps the RESULT protocol line out of the tail the model reads", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {}, { stdout: "step 1: signed in\n" });

    const status = await checkRecording(deps, recordingId);
    expect(status.stdoutTail).toContain("step 1: signed in");
    // The RESULT line is a wire format between the harness and this module.
    // Leaving it in invites the model to parse it and to trust a field this
    // module has already decided about.
    expect(status.stdoutTail).not.toContain("RESULT ");
  });
});

describe("an over-ceiling video is refused readably", () => {
  it("refuses on the reported length, before reading a single byte", async () => {
    // The container tells us how big the file is on the same call that hands
    // back the stream, so a 50MB refusal costs one metadata round trip instead
    // of 50MB of transfer. `unreadableStream` throws if anything pulls it.
    const { deps, finish } = stub({ video: unreadableStream(), size: MAX_RECORDING_BYTES + 1 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const before = (await env.ARTIFACTS.list({ prefix: "proofs/", limit: 1000 })).objects.length;
    const status = await checkRecording(deps, recordingId);

    // The RUN passed and saying otherwise would be a lie; what failed is the
    // publish, and the status says exactly that.
    expect(status.state).toBe("passed");
    expect(status.url).toBeNull();
    expect(status.error).toContain(String(MAX_RECORDING_BYTES));
    expect(status.error).toMatch(/shorter|trim|too large/i);
    // Nothing half-written is left behind for the route to find.
    expect((await env.ARTIFACTS.list({ prefix: "proofs/", limit: 1000 })).objects.length).toBe(
      before,
    );
  });
});

describe("a poll reports a publish failure, it never throws one", () => {
  /**
   * A poll has already collected the harness's verdict, the error the model has
   * to act on, and the tail of its output by the time the upload is attempted.
   * An exception escaping `publish` would throw all of that away and turn a
   * routine poll into a capability failure — and the container being torn down
   * between the RESULT line and the poll is not exotic, it is what happens when
   * a run ends.
   */
  it("survives a container read that fails, keeping the verdict and the tail", async () => {
    // The stub's readBinary throws when no video is configured.
    const { deps, finish } = stub({});
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" }, { stdout: "step 1: signed in\n" });

    const status = await checkRecording(deps, recordingId);

    // The browser journey PASSED. The upload is what failed, and saying
    // otherwise would send the agent to fix code that works.
    expect(status.state).toBe("passed");
    expect(status.url).toBeNull();
    expect(status.error).toContain("could not be published");
    expect(status.stdoutTail).toContain("step 1: signed in");
  });

  it("survives a bucket read that fails, and does NOT delete an already-published proof", async () => {
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {});

    const published = await checkRecording(deps, recordingId);
    const key = keyOf(published.url!);
    expect(await env.ARTIFACTS.head(key)).not.toBeNull();

    // A later poll where the metadata read itself fails. `head` is now inside
    // the try, so the failure is caught — and the cleanup must NOT fire, or a
    // transient R2 blip would destroy the proof an earlier poll published.
    const failing = new Proxy(env.ARTIFACTS, {
      get(target, property) {
        if (property === "head") return () => Promise.reject(new Error("R2 unavailable"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as R2Bucket;

    const status = await checkRecording({ ...deps, bucket: failing }, recordingId);

    expect(status.state).toBe("passed");
    expect(status.url).toBeNull();
    expect(status.error).toContain("could not be published");
    expect(await env.ARTIFACTS.head(key)).not.toBeNull();
  });
});

describe("a stream that ends early is refused, not published", () => {
  /**
   * The failure mode this guards is the quiet one. A read that ERRORS is caught
   * and cleaned up; a read that simply ends early — a torn-down container, a
   * lost RPC frame — looks identical to a complete one from the Worker's side:
   * no exception, a shorter object, a clean upload, and a URL reported as
   * proof. The file plays for a few seconds and stops. Nothing downstream can
   * detect that; a human clicking the link in a customer thread would.
   *
   * The guard is now a PROPERTY OF THE STREAM rather than a comparison this
   * module performs: the container's reported length goes into a
   * `FixedLengthStream`, so a short body fails the `put` itself.
   */
  it("refuses when fewer bytes arrive than the container said the file holds", async () => {
    const { deps, finish } = stub({ video: new Uint8Array([1, 2, 3]), size: 4_096 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const before = (await env.ARTIFACTS.list({ prefix: "proofs/", limit: 1000 })).objects.length;
    const status = await checkRecording(deps, recordingId);

    expect(status.state).toBe("passed");
    expect(status.url).toBeNull();
    expect(status.error).toContain("could not be published");
    expect(status.error).toMatch(/partly transferred|partial mp4/i);
    // Nothing partial is left for the route to find and serve as evidence.
    expect((await env.ARTIFACTS.list({ prefix: "proofs/", limit: 1000 })).objects.length).toBe(
      before,
    );
  });

  it("refuses an empty file rather than publishing a zero-byte proof", async () => {
    const { deps, finish } = stub({ video: new Uint8Array(0) });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const status = await checkRecording(deps, recordingId);
    expect(status.url).toBeNull();
    expect(status.error).toMatch(/empty/i);
  });

  it("publishes normally when the length matches, whatever the harness reported", async () => {
    // `bytes` is no longer consulted: the container's own figure is
    // authoritative, so a harness that under-reports cannot block a publish.
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed", bytes: null });

    const status = await checkRecording(deps, recordingId);
    expect(status.url).not.toBeNull();
    expect(status.error).toBeNull();
  });
});

describe("the URL checkRecording hands back is the URL the route serves", () => {
  /**
   * NOTHING ELSE TESTS THIS SEAM. The publish side reads its object back out of
   * `env.ARTIFACTS` directly and the serving side seeds keys by hand, so URL
   * construction, the `PROOFS_BASE_URL` shape, the key derivation and the route
   * are each proven alone and never together — which is precisely the property
   * the drill depends on: somebody clicks the link the agent reported.
   */
  it("fetches the published recording back through the real route", async () => {
    const bytes = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 9, 9, 9, 7, 7]);
    // `BASE` is this Worker's own origin plus `/proofs`, which is what
    // `PROOFS_BASE_URL` holds in production — so the URL below is fetched from
    // the real route rather than from a shape a test invented.
    const { deps, finish } = stub({ video: bytes });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "passed" });

    const status = await checkRecording(deps, recordingId);
    expect(status.url).not.toBeNull();

    const response = await SELF.fetch(status.url!);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="checkout.mp4"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});

describe("dev-env values never reach the model", () => {
  const SECRET = "sb-secret-9f3a7c21d4e6b8a0";
  const devEnv = { SUPABASE_SECRET_API_KEY: SECRET };

  it("redacts them from stdoutTail", async () => {
    const { deps, finish } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {}, { stdout: `logged in with ${SECRET}\n` });

    const status = await checkRecording(deps, recordingId);

    expect(status.stdoutTail).not.toContain(SECRET);
    expect(status.stdoutTail).toContain("[redacted:SUPABASE_SECRET_API_KEY]");
  });

  it("redacts them from the error, which is where a stack trace puts them", async () => {
    const { deps, finish } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {
      state: "failed",
      error: `Error: request failed with apikey=${SECRET}`,
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.error).not.toContain(SECRET);
    expect(status.error).toContain("[redacted:SUPABASE_SECRET_API_KEY]");
  });

  it("redacts a dev-env value embedded in a publish failure's exception message", async () => {
    // `publish`'s catch block also covers `head()` and `readBinary()` failures
    // against a torn-down container, and its `problem` sentence embeds the
    // caught exception's own message verbatim — exactly the shape a stack
    // trace or an upstream rejection uses to carry a dev-env value. This pins
    // that the embedded message is scrubbed like every other string that
    // reaches `RecordingStatus.error`, not just `result.error`.
    const { deps, finish } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, {});

    const failing: RecordDeps = {
      ...deps,
      async readBinary() {
        throw new Error(`upload rejected by upstream, saw Authorization: Bearer ${SECRET}`);
      },
    };

    const status = await checkRecording(failing, recordingId);

    expect(status.state).toBe("passed");
    expect(status.url).toBeNull();
    expect(status.error).toContain("could not be published");
    expect(status.error).not.toContain(SECRET);
    expect(status.error).toContain("[redacted:SUPABASE_SECRET_API_KEY]");
  });

  it("scrubs before it trims, so a value straddling the cut cannot survive it", async () => {
    const { deps, processes } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    // Positioned so that the LAST seven characters of the value fall inside the
    // kept tail. Trimming first and scrubbing second would leave them there —
    // a leak that every "does the output contain the secret" assertion written
    // against a short log would miss.
    processes.set(recordingId, {
      ...processes.get(recordingId)!,
      stdout: `${"A".repeat(3_000)}${SECRET}${"B".repeat(RECORDING_TAIL_CHARS - 8)}\n`,
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.stdoutTail).not.toContain(SECRET.slice(-7));
    expect(status.stdoutTail.length).toBeLessThanOrEqual(RECORDING_TAIL_CHARS + 200);
  });

  it("scrubs the error before it trims it, too", async () => {
    const { deps, finish } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    // Straddling the head-clamp boundary: trimming first would keep the value's
    // first characters and drop the rest, which reads as a scrub that worked.
    finish(recordingId, {
      state: "failed",
      error: `${"A".repeat(RECORDING_ERROR_CHARS - 10)}${SECRET}${"B".repeat(50)}`,
    });

    const status = await checkRecording(deps, recordingId);

    expect(status.error).not.toContain(SECRET.slice(0, 10));
    expect(status.error).not.toContain(SECRET);
  });

  it("keeps the publish problem even when the harness error fills the budget", async () => {
    // Bounded per part rather than across the join: a single slice over the
    // joined string would drop the half this module wrote, which is the half
    // that explains why there is no URL.
    const { deps, finish } = stub({});
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "failed", error: "E".repeat(RECORDING_ERROR_CHARS * 3) });

    const status = await checkRecording(deps, recordingId);

    expect(status.error).toContain("error truncated");
    expect(status.error).toContain("could not be published");
  });

  it("redacts a running run's tail too, not only a terminal one", async () => {
    const { deps, processes } = stub({ video: MP4, devEnv });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    processes.set(recordingId, {
      ...processes.get(recordingId)!,
      stdout: `env dump: ${SECRET}\n`,
    });

    const status = await checkRecording(deps, recordingId);
    expect(status.state).toBe("running");
    expect(status.stdoutTail).not.toContain(SECRET);
  });
});
