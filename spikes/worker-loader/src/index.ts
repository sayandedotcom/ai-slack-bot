/**
 * Phase 00 · Worker Loader spike
 *
 * Task 6: load an isolate from a string, get a value back, and confirm the
 * load() vs get() cache semantics that inspired-from-ronit.md §5 warns about.
 *
 * Throwaway code, committed as evidence.
 */

type Env = {
  LOADER: WorkerLoader;
};

/**
 * The compatibility date the LOADED isolate runs under. Independent of the
 * parent Worker's date — this is a field on the bundle, not inherited.
 */
const ISOLATE_COMPAT_DATE = "2026-08-01";

/**
 * A minimal isolate: a WorkerEntrypoint whose `run()` returns a value.
 * `run` is not special to the platform; it is just an RPC method name, and it
 * is the one agent-os uses, so the spike matches the shape Phase 09 will copy.
 */
function constantModule(value: unknown): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";
    export default class extends WorkerEntrypoint {
      async run() {
        return ${JSON.stringify(value)};
      }
    }
  `;
}

/** The bundle shape, in one place so every route varies only what it means to. */
function bundle(code: string, extra: Partial<WorkerLoaderWorkerCode> = {}): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: ISOLATE_COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "main.js",
    modules: { "main.js": code },
    // Task 8 tightens this. Stated explicitly even here so no route ever
    // silently inherits a network-capable default.
    globalOutbound: null,
    ...extra,
  };
}

/** RPC methods on a loaded isolate are untyped at the stub boundary. */
type RunnableStub = Fetcher & { run(...args: unknown[]): Promise<unknown> };

function runnable(stub: WorkerStub): RunnableStub {
  return stub.getEntrypoint() as unknown as RunnableStub;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        /**
         * Task 6 Step 1 — does this account have the binding at all?
         * A missing binding is the phase's single biggest lead-time risk, so it
         * gets its own route that touches nothing else.
         */
        case "/available": {
          return json({
            bindingPresent: typeof env.LOADER === "object" && env.LOADER !== null,
            hasLoad: typeof env.LOADER?.load === "function",
            hasGet: typeof env.LOADER?.get === "function",
          });
        }

        /** Task 6 Step 2 — load a module from a string, get a value back. */
        case "/const": {
          const startedAt = Date.now();
          const stub = env.LOADER.load(bundle(constantModule(42)));
          const value = await runnable(stub).run();
          return json({ value, ok: value === 42, wallClockMs: Date.now() - startedAt });
        }

        /**
         * Task 6 Step 3 — the cache trap, demonstrated rather than described.
         *
         * Both halves reuse ONE name with DIFFERENT code:
         *   get()  -> second call must return the FIRST value (stale bundle)
         *   load() -> second call must return the SECOND value (no cache)
         *
         * If get() returns "second", the cache semantics differ from what
         * Phase 09 was designed against and the finding must be written down.
         */
        case "/cache": {
          const name = `cache-probe-${url.searchParams.get("k") ?? "default"}`;

          const getFirst = await runnable(
            env.LOADER.get(name, () => bundle(constantModule("first"))),
          ).run();
          const getSecond = await runnable(
            env.LOADER.get(name, () => bundle(constantModule("second"))),
          ).run();

          const loadFirst = await runnable(env.LOADER.load(bundle(constantModule("first")))).run();
          const loadSecond = await runnable(env.LOADER.load(bundle(constantModule("second")))).run();

          return json({
            get: { first: getFirst, second: getSecond, cached: getSecond === "first" },
            load: { first: loadFirst, second: loadSecond, cached: loadSecond === "first" },
            expectation: "get.cached === true (stale bundle), load.cached === false",
            matchesExpectation: getSecond === "first" && loadSecond === "second",
          });
        }

        default:
          return json({ routes: ["/available", "/const", "/cache"] }, 404);
      }
    } catch (err) {
      // The failure mode is the deliverable; do not prettify it.
      return json(
        {
          error: String(err),
          name: err instanceof Error ? err.name : undefined,
          stack: err instanceof Error ? err.stack : undefined,
        },
        500,
      );
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
