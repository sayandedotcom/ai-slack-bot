import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  checkRecording,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_TIMEOUT_MS,
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
 * More than the ceiling, produced lazily.
 *
 * Materialising 50MB in one buffer would prove nothing about a streaming
 * publisher — the point is that the refusal happens while the bytes are moving,
 * so the chunks are generated on demand and the stream is expected to be torn
 * down partway through.
 */
function oversizedStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > MAX_RECORDING_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

function stub(
  options: {
    video?: Uint8Array | ReadableStream<Uint8Array>;
    devEnv?: Record<string, string>;
    bucket?: R2Bucket;
    now?: () => number;
  } = {},
) {
  const files = new Map<string, string>();
  const spawns: Array<{ command: string; options?: { processId?: string; cwd?: string } }> = [];
  const processes = new Map<string, StubProcess>();
  const reads: string[] = [];

  const deps: RecordDeps = {
    async writeFile(path, content) {
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
      return video instanceof ReadableStream ? video : streamOf(video);
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

  return { deps, files, spawns, processes, reads, finish, crash };
}

const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

/** The key the URL names, for reading the object back out of the bucket. */
const keyOf = (url: string): string => `proofs/${url.slice(`${BASE}/`.length)}`;

describe("startRecording writes the script and spawns the harness", () => {
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

  it("surfaces browser-unavailable as a failure with the harness's own words", async () => {
    const actionable =
      "Chromium is not installed in this container: run `npx playwright install chromium` before recording.";
    const { deps, finish } = stub({ video: MP4 });
    const { recordingId } = await startRecording(deps, { script: "x", label: "checkout" });
    finish(recordingId, { state: "browser-unavailable", error: actionable, video: null });

    const status = await checkRecording(deps, recordingId);

    // The capability layer's tests depend on this exact sentence reaching the
    // model: "browser-unavailable" is not a state the model can act on, and
    // the harness's message is.
    expect(status.state).toBe("failed");
    expect(status.error).toContain(actionable);
    expect(status.url).toBeNull();
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
  it("stores nothing, hands back no URL, and says why in the status", { timeout: 60_000 }, async () => {
    const { deps, finish } = stub({ video: oversizedStream() });
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
