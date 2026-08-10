/**
 * Phase 00 · Worker Loader spike
 *
 * Task 6: load an isolate from a string, get a value back, and confirm the
 * load() vs get() cache semantics that inspired-from-ronit.md §5 warns about.
 *
 * Throwaway code, committed as evidence.
 */

// Both must be exported from the Worker entrypoint for the DO and the
// ctx.exports loopback binding to resolve.
export { SpikeDO, SecretBinding } from "./run-do";
import type { ProbeResult } from "./run-do";

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

/**
 * Task 8 — the escape-attempt probe, run INSIDE the isolate.
 *
 * Every attempt is individually caught so one throw does not mask the rest:
 * the deliverable is a per-route verdict, not a single pass/fail. The exact
 * error string is returned verbatim because the findings doc must quote it
 * rather than paraphrase it.
 *
 * `parentOrigin` is injected rather than hardcoded so the "can it call back to
 * the Worker that loaded it" case tests a real reachable hostname.
 */
function isolationModule(parentOrigin: string): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    async function attempt(label, fn) {
      const startedAt = Date.now();
      try {
        const value = await fn();
        return { label, outcome: "SUCCEEDED", detail: String(value), ms: Date.now() - startedAt };
      } catch (err) {
        return {
          label,
          outcome: "threw",
          error: String(err),
          name: err && err.name,
          ms: Date.now() - startedAt,
        };
      }
    }

    export default class extends WorkerEntrypoint {
      async run() {
        return await Promise.all([
          attempt("fetch:public", async () => {
            const r = await fetch("https://example.com");
            return "status " + r.status;
          }),
          attempt("fetch:parent-worker", async () => {
            const r = await fetch(${JSON.stringify(parentOrigin)} + "/available");
            return "status " + r.status;
          }),
          attempt("fetch:cf-internal", async () => {
            const r = await fetch("http://workers.cloudflare.com/");
            return "status " + r.status;
          }),
          attempt("fetch:ip-literal", async () => {
            const r = await fetch("http://1.1.1.1/");
            return "status " + r.status;
          }),
          attempt("websocket", async () => {
            const ws = new WebSocket("wss://example.com");
            return "constructed, readyState " + ws.readyState;
          }),
          attempt("fetch:global-present", async () => typeof fetch),
          attempt("websocket:global-present", async () => typeof WebSocket),
        ]);
      }
    }
  `;
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

        /**
         * Task 8 — decision D1's entire security story.
         *
         * `?outbound=inherit` re-runs the identical probe WITHOUT
         * globalOutbound: null, to show the field is what does the work. If the
         * two runs agree, the isolation is coming from somewhere else and the
         * claim in spec §8.1 is not the one we think we are making.
         */
        case "/isolation": {
          const inherit = url.searchParams.get("outbound") === "inherit";
          const code = isolationModule(url.origin);

          const stub = env.LOADER.load(
            inherit
              ? // Deliberately omit globalOutbound to get the default.
                {
                  compatibilityDate: ISOLATE_COMPAT_DATE,
                  compatibilityFlags: ["nodejs_compat"],
                  mainModule: "main.js",
                  modules: { "main.js": code },
                }
              : bundle(code),
          );

          const results = (await runnable(stub).run()) as Array<{
            label: string;
            outcome: string;
          }>;

          const networkLabels = [
            "fetch:public",
            "fetch:parent-worker",
            "fetch:cf-internal",
            "fetch:ip-literal",
            "websocket",
          ];
          const escaped = results.filter(
            (r) => networkLabels.includes(r.label) && r.outcome === "SUCCEEDED",
          );

          return json({
            globalOutbound: inherit ? "inherited (control run)" : "null",
            results,
            escaped: escaped.map((r) => r.label),
            // The one line the findings doc quotes.
            verdict: escaped.length === 0 ? "ISOLATED" : "ESCAPED",
          });
        }

        /**
         * Task 7 — binding injection and the credential boundary.
         * `?raw=1` additionally puts a RAW DurableObjectStub on env, which
         * inspired-from-ronit.md §4 predicts fails at the marshalling boundary.
         */
        case "/bindings": {
          const id = env.SPIKE_DO.idFromName("probe");
          // See ProbeResult's doc comment for why this is annotated by hand.
          const spike = env.SPIKE_DO.get(id) as unknown as {
            probe(includeList: string[]): Promise<ProbeResult>;
          };
          // ?include=secret,run,raw — default exercises the two shapes Phase 09
          // actually plans to use.
          const include = (url.searchParams.get("include") ?? "secret,run")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const result = await spike.probe(include);

          // The finding that matters, computed rather than eyeballed.
          const leaked =
            result.probe?.attempts.some(
              (a) => a.label !== "leak-control" && a.detail?.includes("SPIKE_SECRET_VALUE"),
            ) ?? false;

          return json({ ...result, secretReachableByAnyNonControlPath: leaked });
        }

        default:
          return json(
            { routes: ["/available", "/const", "/cache", "/isolation", "/bindings"] },
            404,
          );
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
