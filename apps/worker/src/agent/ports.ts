import type { Env } from "../index";
import {
  installRunPorts,
  type AgentContinuation,
  type ClaimedGeneration,
  type ContinuationOutcome,
  type RunPorts,
} from "./driver";
import { makeMemoryOutboxRunner } from "./memory";
import { makeUsageProjectionRunner } from "./usage";
import { readState } from "../run/session";

/**
 * THE PRODUCTION WIRING. The one place the shipping loop is attached to the
 * shipping driver.
 *
 * Everything it installs was built, tested and unreachable. `installRunPorts`
 * had no production call site at all, which meant a deploy ran a RunDO whose
 * `continuation` was `null` — model work parked forever, in the phase whose
 * entire subject is the model loop — and whose `memory_outbox` jobs had no
 * runner, so every memory projection parked instead of being delivered. Both
 * were green in CI the whole time, because every test installed its own ports.
 *
 * Two properties are worth stating outright, because they are what a reviewer
 * of this file is actually checking:
 *
 *  - `additionalGuard: alwaysFresh()` does NOT disable freshness checking.
 *    Invariant 15's real gate is `generationFreshnessGuard`, which
 *    `makeAgentContinuation` composes itself, under AND-semantics, and which no
 *    caller can switch off. `additionalGuard` is the honest name for the
 *    ADDITIONAL check this call site adds on top of it, and "nothing extra" has
 *    to be typed out rather than defaulted, precisely so this line is read.
 *
 *  - nothing here branches on origin. The Chat surface and the Slack surface
 *    both reach this one registration; there is no `handleChatAgent`, no
 *    `handleSlackAgent`, and origin enters the loop only as trusted
 *    presentation context read from `run_state` (invariants 3 and 4).
 */

/**
 * The settings the production composer needs, BY NAME.
 *
 * Names only, here and everywhere downstream of here. This array is quoted into
 * a report that reaches an operator over HTTP; a value never is (invariant 39).
 *
 * The AUTHORITY on what a valid Gateway endpoint looks like remains
 * `createProductionModelFactory` — the https scheme, the provider-native host,
 * the refusal to fall back to a direct Anthropic call. This list is presence
 * only, deliberately, because duplicating those rules would create a second,
 * quietly diverging copy of the one check that stands between us and an
 * unmetered provider call.
 */
const REQUIRED_MODEL_CONFIGURATION = [
  "ANTHROPIC_API_KEY",
  "AI_GATEWAY_ANTHROPIC_URL",
  "AI_GATEWAY_TOKEN",
] as const;

/**
 * How this deployment stands with respect to model work.
 *
 *  - `ready`: configured; the real continuation is installed.
 *  - `disabled_by_configuration`: SOMEBODY DELIBERATELY TURNED IT OFF with
 *    `AGENT_MODEL_DISABLED`. Model work parks; projections still drain.
 *  - `configuration_incomplete`: nobody turned it off and the settings are not
 *    there. The continuation is STILL installed, and composition fails loudly
 *    the first time a generation is claimed.
 */
export type ModelStatus = "ready" | "disabled_by_configuration" | "configuration_incomplete";

export type ProductionPortsReport = {
  /**
   * Whether a continuation was installed at all — NOT whether model work can
   * succeed.
   *
   * The distinction is the whole reason this field is not called
   * `modelEnabled` any more. On a deployment with no Gateway settings the
   * continuation IS installed (that is what makes absence fail loudly instead
   * of parking silently), so `modelEnabled: true` rendered on `/api/health` as
   * "model: enabled" for a deployment where every single model call is
   * guaranteed to fail. `status` is the field that says whether it will work;
   * this one says only that something is wired.
   */
  continuationInstalled: boolean;
  /** A stable operator-facing code. Never carries a configured VALUE. */
  status: ModelStatus;
  /** NAMES of required settings that are absent. Never their values. */
  missingConfiguration: string[];
};

/**
 * The opt-out. Explicit, and it is an opt-out rather than the old presence
 * check for one reason: ABSENCE MUST NOT BE A SILENT MODE.
 *
 * The gate this replaces asked "is the Gateway configured?" and parked when the
 * answer was no. That inverts plan lines 965-966, which require the production
 * composer to FAIL when the Gateway URL is absent: composition was never
 * attempted, so it could never fail, and a deploy that forgot a secret
 * presented a dashboard full of `live` runs with `error: null` that would never
 * move. The only signal was one `console.warn` per isolate.
 *
 * Now absence is a loud typed failure and only this flag parks. It is safe in
 * exactly the direction a flag near a credential has to be: setting it can only
 * make the agent do LESS. It cannot select a provider, cannot relax the Gateway
 * host check, and cannot cause a direct-to-Anthropic call — `agent/model.ts`
 * still refuses everything it refused before. There is no value of this flag
 * that turns a missing Gateway into a permitted network call.
 *
 * Read strictly: only `1` and `true` disable. A typo therefore fails loudly
 * rather than quietly parking, which is the whole point of the change.
 */
function modelDeliberatelyDisabled(env: Env): boolean {
  const raw = env.AGENT_MODEL_DISABLED?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true";
}

/**
 * The composition report, as a pure function of `env`.
 *
 * Callable from any isolate — the Worker entry serves it on `/api/health` and
 * beside every run snapshot, and neither of those has run a RunDO constructor.
 */
export function modelDisposition(env: Env): ProductionPortsReport {
  const missingConfiguration = REQUIRED_MODEL_CONFIGURATION.filter(
    (name) => (env[name]?.trim() ?? "") === "",
  );

  if (modelDeliberatelyDisabled(env)) {
    return {
      continuationInstalled: false,
      status: "disabled_by_configuration",
      missingConfiguration,
    };
  }
  return {
    continuationInstalled: true,
    status: missingConfiguration.length === 0 ? "ready" : "configuration_incomplete",
    missingConfiguration,
  };
}

/**
 * The real continuation, behind a deferred module load.
 *
 * `loop.ts` and `model.ts` are reached with `await import()` rather than a
 * static import, and the reason is a test seam, not cold-start cost.
 *
 * State the reason accurately, because the obvious version of it is FALSE.
 * `@ai-sdk/anthropic` is already in this Worker's eager module graph and this
 * import style does nothing about that: `src/index.ts` statically imports
 * `./triage/run`, whose first line is
 * `import { createAnthropic } from "@ai-sdk/anthropic"`. Nothing here keeps the
 * Anthropic SDK out of a cold start, and claiming otherwise would be a comment
 * a reader could disprove in one grep.
 *
 * What it does keep out is `src/agent/model.ts` — this module's OWN
 * evaluation. `src/index.ts` imports `modelDisposition` from this file, so this
 * file IS eager; a static `import "./model"` here would evaluate `model.ts` as
 * part of the entry graph, before any test module runs, binding the real
 * `createAnthropic` for good. `agent-gateway.test.ts` spies on `createAnthropic`
 * through `vi.mock("@ai-sdk/anthropic")` to prove the positive half of the
 * credential contract — that `cf-aig-authorization` is actually attached to
 * every provider request, a property whose deletion once left the entire suite
 * green while production called the Gateway unauthenticated. A module the entry
 * graph has already evaluated cannot be re-bound by that mock, so the spy would
 * record ZERO calls and six cases would fail. (Measured: making this a static
 * import fails exactly those six.)
 *
 * Wiring the loop up must not cost the one test that can tell "the token was
 * correctly withheld from the snapshot" apart from "the token was never
 * attached at all".
 *
 * `run()` is already async and is already built per claimed attempt, so the
 * load costs one resolved promise on a path that is about to call a provider.
 */
function productionContinuation(ctx: DurableObjectState, env: Env): AgentContinuation {
  return {
    async run(claim: ClaimedGeneration): Promise<ContinuationOutcome> {
      const [{ makeAgentContinuation }, { createProductionModelFactory }, { alwaysFresh }] =
        await Promise.all([
          import("./loop"),
          import("./model"),
          import("../codemode/contracts"),
        ]);

      return makeAgentContinuation(ctx, env, {
        /**
         * Composed INSIDE the factory call, not around it, and the difference
         * is worth a line.
         *
         * `createProductionModelFactory` throws `ModelCompositionError` on a
         * missing or malformed Gateway setting. Called out here, that throw
         * escapes `makeAgentContinuation` entirely and reaches the RunDO as a
         * bare exception, which `crashOutcome` — correctly, knowing nothing
         * about it — classifies as a RETRYABLE crash. A configuration mistake
         * would then spend the whole attempt budget and terminate the run as
         * `driver_attempts_exhausted`, naming the run rather than the setting.
         *
         * Called in here, it lands inside `composeAndRun`'s try, where
         * `classifyThrown` recognises the type and produces a terminal
         * `requires_operator_config` failure carrying the specific error code.
         * One retry against a value that cannot fix itself is one too many.
         */
        modelFactory: (invocation) => createProductionModelFactory(env)(invocation),
        // NOT a disabled guard. See the note at the top of this file: the
        // durable `generationFreshnessGuard` is always ANDed in underneath and
        // cannot be switched off from here.
        additionalGuard: alwaysFresh(),
      }).run(claim);
    },
  };
}

export function productionRunPorts(env: Env): {
  ports: Partial<RunPorts>;
  report: ProductionPortsReport;
} {
  const projections: RunPorts["projections"] = {
    /**
     * Task 9's runner, reached from production for the first time here.
     *
     * `origin` and `channelId` come from THIS object's `run_state` — the same
     * trusted source `resolveCodeModeScope` uses — and never from the job, the
     * queue message or a turn. Which graph an episode lands in is therefore
     * decided from host state, once, at delivery.
     */
    memory_outbox: (ctx, workerEnv) => {
      const state = readState(ctx.storage);
      return makeMemoryOutboxRunner({
        storage: ctx.storage,
        db: workerEnv.DB,
        queue: workerEnv.MEMORY_QUEUE,
        origin: state?.origin ?? "chat",
        channelId: state?.channelId ?? null,
      });
    },
    /**
     * Without this, `agent_model_calls` stays empty forever and every cost
     * reading in the dashboard is zero while the money is genuinely being
     * spent. The local `model_step_usage` row is the system of record; this is
     * the projection that makes it queryable across runs (invariant 32).
     */
    d1_usage: (ctx, workerEnv) =>
      makeUsageProjectionRunner({ storage: ctx.storage, db: workerEnv.DB }),
  };

  const report = modelDisposition(env);

  /**
   * The one bit `RunDO`'s constructor needs to decide whether a run that died
   * for want of configuration may be picked back up (`resumeAfterOperatorConfig`).
   *
   * `status === "ready"` and not merely "the settings are present": a deployment
   * that deliberately opted out with `AGENT_MODEL_DISABLED` must not revive
   * anything, because turning model work off is not supplying configuration.
   */
  const modelConfigured = report.status === "ready";

  // Parking keeps the projections. A deployment that cannot call the model must
  // still drain the memory and usage work its earlier runs committed, or a
  // missing setting quietly becomes lost telemetry and lost memory.
  if (!report.continuationInstalled) {
    return { ports: { projections, modelConfigured }, report };
  }

  // Installed even when `missingConfiguration` is non-empty, and that is the
  // plan-mandated behaviour rather than an oversight. `createProductionModelFactory`
  // is composed INSIDE `composeAndRun`'s try (see `productionContinuation`), so
  // a missing Gateway URL surfaces as a TERMINAL `requires_operator_config`
  // failure carrying `missing_gateway_url` — visible on the run's own driver
  // state — instead of burning the attempt budget or parking in silence.
  return {
    ports: { continuation: productionContinuation, projections, modelConfigured },
    report,
  };
}

/**
 * Install the production ports exactly once per isolate.
 *
 * Called from the RunDO constructor rather than at module scope, for the
 * ordinary reason that the ports need `env` and module scope has none — and
 * from the CONSTRUCTOR specifically because that is the earliest point every
 * entry into an object shares. An alarm delivery, a WebSocket upgrade, a queue
 * consumer's RPC and constructor crash recovery all run it before anything
 * reads `resolveRunPorts`.
 *
 * These are GLOBAL ports. A key-scoped registration still wins, which is what
 * keeps every test's fake continuation authoritative for the one run it minted.
 */
let installed = false;
let report: ProductionPortsReport | null = null;

export function ensureRunPortsInstalled(env: Env): ProductionPortsReport {
  if (installed && report !== null) return report;
  const built = productionRunPorts(env);
  installRunPorts(built.ports);
  installed = true;
  report = built.report;
  // A log line, and NOT the operator signal — an isolate log is invisible to the
  // dashboard and gone by the time anyone asks why a run has not moved. The
  // signal is `modelDisposition()` on `/api/health` and beside every run
  // snapshot; this is only here so the reason is in the trace next to the first
  // affected request.
  if (built.report.status !== "ready") {
    console.warn(
      `[agent] model status ${built.report.status}; missing: ${
        built.report.missingConfiguration.join(", ") || "nothing"
      }`,
    );
  }
  return built.report;
}

/** Test seam: forget the once-per-isolate memo. Does not uninstall the ports. */
export function resetProductionPortsMemo(): void {
  installed = false;
  report = null;
}
