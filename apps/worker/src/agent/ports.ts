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
 * Whether this deployment is configured to call the model at all.
 *
 * Presence only. The AUTHORITY on what a valid Gateway endpoint looks like is
 * `createProductionModelFactory` — the https scheme, the provider-native host,
 * the refusal to fall back to a direct Anthropic call — and duplicating those
 * rules here would create a second, quietly diverging copy of the one check
 * that stands between us and an unmetered provider call.
 *
 * So the split is: absent configuration PARKS, wrong configuration FAILS.
 *
 * Parking is right for absence because it is recoverable and truthful. The
 * generation stays `scheduled`, the input stays above the settled watermark,
 * and the first alarm after the Gateway is created picks the run up exactly
 * where it was left — which is the state this repository is actually in, since
 * creating the private Gateway is a deferred operator step (see
 * `.dev.vars.example`). Installing a continuation that throws on every claim
 * would instead spend the driver's attempt budget and terminate waiting
 * customer runs as `driver_attempts_exhausted`, naming the run rather than the
 * missing setting.
 *
 * Failing is right for a value that is present but wrong, because that is a
 * mistake somebody made rather than a step nobody has taken yet, and it
 * surfaces through `classifyThrown` as a typed `requires_operator_config`
 * outcome carrying the specific composition error code.
 */
function hasModelConfiguration(env: Env): boolean {
  return (
    (env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" &&
    (env.AI_GATEWAY_ANTHROPIC_URL?.trim() ?? "") !== "" &&
    (env.AI_GATEWAY_TOKEN?.trim() ?? "") !== ""
  );
}

export type ProductionPortsReport = {
  modelEnabled: boolean;
  /** Why model work is parked, when it is. */
  modelDisabledReason: string | null;
};

/**
 * The real continuation, behind a deferred module load.
 *
 * `loop.ts` and `model.ts` are reached with `await import()` rather than a
 * static import, and the reason is not cold-start micro-optimization — though a
 * Slack ingest request that never touches the model genuinely stops paying to
 * instantiate the Anthropic SDK.
 *
 * The reason is that a static import here puts `@ai-sdk/anthropic` in the
 * Worker's EAGER module graph, and the Worker entry is instantiated before any
 * test module. `agent-gateway.test.ts` spies on `createAnthropic` to prove the
 * positive half of the credential contract — that `cf-aig-authorization` is
 * actually attached to every provider request, a property whose deletion once
 * left the entire suite green while production called the Gateway
 * unauthenticated. That spy is a module mock, and a module the entry graph has
 * already instantiated cannot be intercepted by one. Wiring the loop up must
 * not cost the one test that can tell "the token was correctly withheld from
 * the snapshot" apart from "the token was never attached at all".
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

  if (!hasModelConfiguration(env)) {
    return {
      ports: { projections },
      report: {
        modelEnabled: false,
        modelDisabledReason:
          "ANTHROPIC_API_KEY, AI_GATEWAY_ANTHROPIC_URL and AI_GATEWAY_TOKEN must all be set before the agent may call the model",
      },
    };
  }

  return {
    ports: { continuation: productionContinuation, projections },
    report: { modelEnabled: true, modelDisabledReason: null },
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
  if (!built.report.modelEnabled) {
    console.warn(`[agent] model work is parked: ${built.report.modelDisabledReason}`);
  }
  return built.report;
}

/** Test seam: forget the once-per-isolate memo. Does not uninstall the ports. */
export function resetProductionPortsMemo(): void {
  installed = false;
  report = null;
}
