/**
 * Render the model-visible capability declarations from the real Zod schemas.
 *
 * `--write` updates src/codemode/generated/capabilities.d.ts.
 * `--check` renders in memory and exits non-zero on any difference, without
 * touching the worktree — CI must report drift, not silently repair it.
 *
 * Run through scripts/codemode-node-shim.mjs; see that file for why.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCapabilityDeclarations } from "../src/codemode/dts";
import { buildRegistry } from "../src/codemode/registry";
import {
  alwaysFresh,
  PRODUCTION_LIMITS,
  type CodeModeScope,
} from "../src/codemode/contracts";
import { newCodeExecution } from "../src/codemode/bindings/shared";
import type { CapabilityDependencies } from "../src/codemode/gateways";

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolvePath(here, "../src/codemode/generated/capabilities.d.ts");

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
    clock: () => 0,
  };
}

/**
 * A scope with no real identifiers. Nothing about the run reaches the rendered
 * declarations — if it did, the artifact would differ per run and `--check`
 * would be meaningless.
 */
const RENDER_SCOPE: CodeModeScope = {
  runId: "render",
  turnId: "render",
  origin: "chat",
  shadow: false,
  customerSlug: null,
  slackThread: null,
  actor: null,
};

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
    console.error("usage: generate-codemode-dts.ts (--write | --check)");
    process.exit(2);
  }

  const registry = buildRegistry(
    RENDER_SCOPE,
    unreachableDependencies(),
    PRODUCTION_LIMITS,
    renderExecution(),
  );
  const rendered = renderCapabilityDeclarations(registry);

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
      `${OUTPUT} does not exist. Run \`pnpm codemode:dts\` and commit the result.`,
    );
    process.exit(1);
    return;
  }

  if (existing !== rendered) {
    console.error(
      "the committed capability declarations are stale.\n" +
        "Run `pnpm codemode:dts` and commit the result.",
    );
    process.exit(1);
    return;
  }
  console.log("capability declarations are up to date");
}

await main();
