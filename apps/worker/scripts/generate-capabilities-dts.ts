/**
 * Render the model-visible capability declarations from the real connectors.
 *
 * `--write` updates src/capabilities/generated/capabilities.d.ts.
 * `--check` renders in memory and exits non-zero on any difference, without
 * touching the worktree — CI must report drift, not silently repair it.
 *
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { renderDeclarationsFromConnectors } from "../src/capabilities/dts";
import {
  alwaysFresh,
  newCodeExecution,
  PRODUCTION_LIMITS,
} from "../src/capabilities/execution";
import { buildConnectors } from "../src/capabilities/registry";
import type { CapabilityDependencies } from "../src/gateways/ports";
import type { RunScope } from "../src/gateways/scope";
import type { Env } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolvePath(
  here,
  "../src/capabilities/generated/capabilities.d.ts"
);

/**
 * Rendering reads schemas and descriptions only — it never invokes a
 * capability. Every gateway therefore throws: if that assumption ever stops
 * holding, this fails loudly instead of quietly reaching a real vendor from a
 * build script.
 */
function unreachableDependencies(): CapabilityDependencies {
  const refuse = (what: string) => () => {
    throw new Error(`the declaration generator must not call ${what}`);
  };
  const gateway = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, method) => refuse(`${name}.${String(method)}`),
    });

  return {
    db: gateway("db") as never,
    slack: gateway("slack") as never,
    memory: gateway("memory") as never,
    linear: gateway("linear") as never,
    supabase: gateway("supabase") as never,
    langsmith: gateway("langsmith") as never,
    betterstack: gateway("betterstack") as never,
    files: gateway("files") as never,
    approval: gateway("approval") as never,
    sandbox: gateway("sandbox") as never,
    github: gateway("github") as never,
    clock: () => 0,
  };
}

/**
 * A scope with no real identifiers. Nothing about the run reaches the rendered
 * declarations — if it did, the artifact would differ per run and `--check`
 * would be meaningless.
 */
const RENDER_SCOPE: RunScope = {
  runId: "render",
  turnId: "render",
  origin: "chat",
  shadow: false,
  customerSlug: null,
  slackThread: null,
  actor: null,
};

/**
 * `FirefighterConnector` extends `CodemodeConnector`, whose constructor takes
 * the Worker `env` and stores it — nothing on the render path reads a binding
 * off it. This proxy makes that measurable rather than assumed, for the same
 * reason the gateways above throw: a build script must never hold a live
 * binding, and if one is ever read here it should be a loud failure, not a
 * vendor call from `pnpm capabilities:dts`.
 */
function unreachableEnv(): Env {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, binding) {
      throw new Error(
        `the declaration generator must not read env.${String(binding)}`
      );
    },
  }) as unknown as Env;
}

/**
 * `describe()` only reads names, descriptions and schemas, so the connectors
 * never need a real execution context. A `waitUntil` that drops its argument
 * is the whole surface a connector could reach for, and dropping it is correct
 * here: there is no request to keep alive.
 */
const renderContext = () => ({ waitUntil() {} }) as unknown as ExecutionContext;

const silentAudit = {
  async started() {},
  async completed() {},
  async failed() {},
};

/**
 * A throwaway execution, for the same reason the gateways above are
 * unreachable: rendering reads schemas, so nothing here is ever charged,
 * audited or resolved. It is built through the production constructor rather
 * than hand-rolled so a field added to `CodeExecution` cannot leave this script
 * silently constructing a half-built one.
 */
const renderExecution = () =>
  newCodeExecution({
    outerToolCallId: "render",
    audit: silentAudit,
    guard: alwaysFresh(),
    limits: PRODUCTION_LIMITS,
    clock: () => 0,
  });

async function main(): Promise<void> {
  const mode = process.argv.includes("--write")
    ? "write"
    : process.argv.includes("--check")
      ? "check"
      : null;

  if (mode === null) {
    console.error("usage: generate-capabilities-dts.ts (--write | --check)");
    process.exit(2);
  }

  // Rendered from the connectors, not the registry: `describe()` is the same
  // call the codemode runtime makes, so the committed artifact is what the
  // model is actually handed. Both build over the same `buildNamespaces`
  // descriptors, so this is a change of vantage point, not of content.
  const connectors = buildConnectors(
    renderContext(),
    unreachableEnv(),
    async (_executionId) => ({
      scope: RENDER_SCOPE,
      deps: unreachableDependencies(),
      limits: PRODUCTION_LIMITS,
      execution: renderExecution(),
    })
  );
  const rendered = await renderDeclarationsFromConnectors(connectors);

  if (mode === "write") {
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, rendered, "utf8");
    console.log(`wrote ${OUTPUT}`);
    return;
  }

  let existing: string;
  try {
    existing = await readFile(OUTPUT, "utf8");
  } catch {
    console.error(
      `${OUTPUT} does not exist. Run \`pnpm capabilities:dts\` and commit the result.`
    );
    process.exit(1);
    return;
  }

  if (existing !== rendered) {
    console.error(
      "the committed capability declarations are stale.\n" +
        "Run `pnpm capabilities:dts` and commit the result."
    );
    process.exit(1);
    return;
  }
  console.log("capability declarations are up to date");
}

await main();
