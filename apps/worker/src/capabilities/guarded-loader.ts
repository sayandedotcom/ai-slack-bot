import type { CapabilityLimits } from "./execution";

/**
 * The bundle's compatibility date, which is NOT the same knob as
 * `wrangler.jsonc`'s. `@cloudflare/codemode` hardcodes `2025-06-01` in its
 * `load()` call (verified at dist/index.js:333), so without this override the
 * isolate running model code would sit on a different runtime semantic than
 * every other line of this project.
 */
const PROJECT_COMPAT_DATE = "2026-08-01";
const PROJECT_COMPAT_FLAGS: readonly string[] = ["nodejs_compat"];

function assertOnlyExpectedModules(
  modules: WorkerLoaderWorkerCode["modules"],
  mainModule: string
): void {
  const names = Object.keys(modules);
  if (names.length !== 1 || names[0] !== mainModule) {
    // Naming the count and the expected entry, never the module bodies: those
    // are model-authored and can be arbitrarily long.
    throw new Error(
      `unexpected module set: expected exactly [${mainModule}], got ${names.length} entr${names.length === 1 ? "y" : "ies"}`
    );
  }
}

function assertEmptyEnv(env: unknown): void {
  if (env === undefined || env === null) return;
  if (typeof env !== "object" || Object.keys(env as object).length > 0) {
    throw new Error(
      "the loaded Worker's env must be empty: capabilities cross as call arguments, never as bindings"
    );
  }
}

function assertNoTails(code: WorkerLoaderWorkerCode): void {
  if (
    (code.tails && code.tails.length > 0) ||
    (code.streamingTails && code.streamingTails.length > 0)
  ) {
    throw new Error(
      "the loaded Worker must not attach a tail consumer: it would stream capability arguments to another Worker"
    );
  }
}

/**
 * Wrap the real `LOADER` binding so that every Dynamic Worker this project
 * loads is isolated by construction rather than by the caller remembering to
 * ask.
 *
 * A pure function over a captured object on purpose — nothing here runs an
 * isolate, so the security invariants can be reviewed and tested without any
 * timing or flakiness. The security fields are *set*, not defaulted: reading
 * `code.globalOutbound ?? null` would let a future SDK version that passes a
 * Fetcher quietly reconnect the sandbox to the network.
 *
 * Not exported beyond the Code Mode executor factory. A second call site is a
 * second place to get this wrong.
 */
export function guardLoader(
  real: WorkerLoader,
  limits: CapabilityLimits
): WorkerLoader {
  return {
    load(code: WorkerLoaderWorkerCode): WorkerStub {
      assertOnlyExpectedModules(code.modules, code.mainModule);
      assertEmptyEnv(code.env);
      assertNoTails(code);

      // A new object every time. Mutating the package's own bundle in place
      // would make the guarantee depend on when the package reads its fields.
      return real.load({
        ...code,
        compatibilityDate: PROJECT_COMPAT_DATE,
        compatibilityFlags: [...PROJECT_COMPAT_FLAGS],
        globalOutbound: null,
        env: undefined,
        tails: undefined,
        streamingTails: undefined,
        // A caller may ask for less than the reviewed ceiling but never more.
        limits: {
          cpuMs: Math.min(code.limits?.cpuMs ?? limits.cpuMs, limits.cpuMs),
          subRequests: Math.min(
            code.limits?.subRequests ?? limits.subRequests,
            limits.subRequests
          ),
        },
      });
    },

    get(): never {
      throw new Error(
        "codemode never uses get(): it is cached by name and would run stale model code"
      );
    },
  };
}
