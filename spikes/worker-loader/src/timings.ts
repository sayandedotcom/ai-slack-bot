/**
 * Phase 00 · Worker Loader spike — Task 9
 *
 * What the agent loop will pay: load/execute latency, whether console.log can
 * be captured at all, and the real wall-clock ceiling.
 *
 * The ceiling number is load-bearing for Phase 11: it is the reason an isolate
 * cannot be parked waiting for a human to click approve, and therefore why
 * escalate() returns immediately.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

const ISOLATE_COMPAT_DATE = "2026-08-01";

/**
 * Tail events are delivered out-of-band, so the collector cannot return them
 * to the caller directly. It parks them in a module-global keyed by runId,
 * which the caller drains after the run. Fine for a spike; Phase 09 would use
 * the DO.
 */
const LOG_SINK = new Map<string, unknown[]>();

/**
 * `tails: Fetcher[]` on the bundle is how a loaded isolate's console output
 * leaves the isolate. Registered via ctx.exports like any other binding.
 */
export class LogCollector extends WorkerEntrypoint<Env, { runId: string }> {
  async tail(events: unknown[]): Promise<void> {
    const runId = this.ctx.props.runId;
    const existing = LOG_SINK.get(runId) ?? [];
    LOG_SINK.set(runId, [...existing, ...events]);
  }
}

export function drainLogs(runId: string): unknown[] {
  const logs = LOG_SINK.get(runId) ?? [];
  LOG_SINK.delete(runId);
  return logs;
}

/** Emits logs and returns a value, so both capture paths are exercised at once. */
const LOGGING_MODULE = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run(logCount, logSize) {
      for (let i = 0; i < logCount; i++) {
        console.log("log-" + i + ":" + "x".repeat(logSize));
      }
      console.error("an error line");
      console.warn("a warn line");
      return { returned: "value", loggedLines: logCount + 2 };
    }
  }
`;

/** Busy-waits on CPU, to find out what limits.cpuMs actually enforces. */
const CPU_BURN_MODULE = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run(targetMs) {
      const start = Date.now();
      let n = 0;
      while (Date.now() - start < targetMs) { n += Math.sqrt(n + 1); }
      return { burnedMs: Date.now() - start, n };
    }
  }
`;

/** Sleeps without consuming CPU, to separate wall-clock from CPU limits. */
const SLEEP_MODULE = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run(sleepMs) {
      await new Promise((r) => setTimeout(r, sleepMs));
      return { sleptMs: sleepMs };
    }
  }
`;

type Runnable = { run(...args: unknown[]): Promise<unknown> };

/**
 * The wall-clock guard from inspired-from-ronit.md §6. Worker Loader's own cap
 * is CPU time, so wall-clock has to be enforced by racing. The late rejection
 * is swallowed so a lost race does not surface as an unhandled rejection.
 */
export async function withWallClock<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`exec_timeout: exceeded ${timeoutMs}ms`)), timeoutMs),
  );
  timeout.catch(() => {});
  return Promise.race([promise, timeout]);
}

export type TimingReport = Record<string, unknown>;

export async function measure(
  loader: WorkerLoader,
  exports: Cloudflare.Exports,
  mode: string,
  params: URLSearchParams,
): Promise<TimingReport> {
  const bundle = (code: string, extra: Partial<WorkerLoaderWorkerCode> = {}) => ({
    compatibilityDate: ISOLATE_COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "main.js",
    modules: { "main.js": code },
    globalOutbound: null,
    ...extra,
  });

  switch (mode) {
    /** Step 1 — load + execute, cold and warm. */
    case "latency": {
      const iterations = Number(params.get("n") ?? 10);
      const cold: number[] = [];
      const warmGet: number[] = [];

      for (let i = 0; i < iterations; i++) {
        // Unique code each time: nothing to reuse, the Phase 09 case.
        const t0 = Date.now();
        const stub = loader.load(bundle(`
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async run() { return ${i}; }
          }
        `));
        await (stub.getEntrypoint() as unknown as Runnable).run();
        cold.push(Date.now() - t0);
      }

      // Same name + same code: the cached path.
      for (let i = 0; i < iterations; i++) {
        const t0 = Date.now();
        const stub = loader.get("warm-probe", () => bundle(`
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async run() { return "warm"; }
          }
        `));
        await (stub.getEntrypoint() as unknown as Runnable).run();
        warmGet.push(Date.now() - t0);
      }

      const stats = (xs: number[]) => ({
        min: Math.min(...xs),
        max: Math.max(...xs),
        mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2),
        median: [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)],
        samples: xs,
      });

      return {
        iterations,
        loadUniqueCode: stats(cold),
        getCachedByName: stats(warmGet),
        note: "ms covers load() + getEntrypoint() + run() round trip",
      };
    }

    /** Step 2 — console.log capture and its size ceiling. */
    case "logs": {
      const logCount = Number(params.get("count") ?? 5);
      const logSize = Number(params.get("size") ?? 100);
      const runId = `logs-${Date.now()}-${Math.random()}`;

      const stub = loader.load(
        bundle(LOGGING_MODULE, {
          tails: [exports.LogCollector({ props: { runId } })],
        }),
      );
      const returned = await (stub.getEntrypoint() as unknown as Runnable).run(logCount, logSize);

      // Tail delivery is out-of-band; give it a beat to arrive.
      await new Promise((r) => setTimeout(r, 250));
      const events = drainLogs(runId);

      // Dig the actual log lines out of the trace events.
      const logs: Array<{ level?: string; message?: unknown }> = [];
      for (const ev of events as Array<Record<string, unknown>>) {
        for (const entry of (ev?.logs as Array<Record<string, unknown>>) ?? []) {
          logs.push({ level: entry.level as string, message: entry.message });
        }
      }

      return {
        requested: { logCount, logSize },
        returnValue: returned,
        tailEventCount: events.length,
        capturedLogCount: logs.length,
        capturedSample: logs.slice(0, 3),
        truncated: logs.length < logCount + 2,
        note: "returnValue and console output are separate channels; Phase 09 needs both",
      };
    }

    /**
     * Step 3 — the wall-clock ceiling, plus what limits.cpuMs and
     * limits.subRequests actually enforce.
     */
    case "ceiling": {
      const results: Record<string, unknown> = {};

      // A. CPU burn against a low cpuMs limit.
      for (const cpuMs of [50, 200]) {
        const targetMs = 1000;
        const t0 = Date.now();
        try {
          const stub = loader.load(bundle(CPU_BURN_MODULE, { limits: { cpuMs } }));
          const out = await (stub.getEntrypoint() as unknown as Runnable).run(targetMs);
          results[`cpuMs=${cpuMs} burn ${targetMs}ms`] = {
            outcome: "completed",
            out,
            wallMs: Date.now() - t0,
          };
        } catch (err) {
          results[`cpuMs=${cpuMs} burn ${targetMs}ms`] = {
            outcome: "threw",
            error: String(err),
            wallMs: Date.now() - t0,
          };
        }
      }

      // B. Sleep — wall-clock time that costs no CPU. Shows cpuMs does not cap it.
      for (const sleepMs of [500, 2000]) {
        const t0 = Date.now();
        try {
          const stub = loader.load(bundle(SLEEP_MODULE, { limits: { cpuMs: 50 } }));
          const out = await (stub.getEntrypoint() as unknown as Runnable).run(sleepMs);
          results[`sleep ${sleepMs}ms @ cpuMs=50`] = {
            outcome: "completed",
            out,
            wallMs: Date.now() - t0,
          };
        } catch (err) {
          results[`sleep ${sleepMs}ms @ cpuMs=50`] = {
            outcome: "threw",
            error: String(err),
            wallMs: Date.now() - t0,
          };
        }
      }

      // C. The race guard actually firing.
      const t0 = Date.now();
      try {
        const stub = loader.load(bundle(SLEEP_MODULE));
        await withWallClock((stub.getEntrypoint() as unknown as Runnable).run(3000), 500);
        results["race guard: 3000ms work, 500ms budget"] = {
          outcome: "completed (guard did NOT fire)",
          wallMs: Date.now() - t0,
        };
      } catch (err) {
        results["race guard: 3000ms work, 500ms budget"] = {
          outcome: "threw",
          error: String(err),
          wallMs: Date.now() - t0,
        };
      }

      return results;
    }

    default:
      return { modes: ["latency", "logs", "ceiling"] };
  }
}
