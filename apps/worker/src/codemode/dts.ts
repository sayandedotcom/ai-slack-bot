import {
  generateTypesFromJsonSchema,
  type CodemodeConnector,
} from "@cloudflare/codemode";
import { generateTypes } from "@cloudflare/codemode/ai";
import { FILES_DECLARATIONS } from "./bindings/files";
import type { CapabilityRegistry } from "./registry";

/**
 * Pinned so the generated artifact records which generator produced it. The
 * emitted shape is compiled-output behaviour, not API shape, so a patch release
 * can change it without changing a single type.
 */
export const CODEMODE_VERSION = "0.5.1";

const HEADER = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  pnpm codemode:dts
// Verify in CI with: pnpm codemode:dts:check
//
// Rendered from the capability connectors' describe() by
// @cloudflare/codemode@${CODEMODE_VERSION}'s generateTypesFromJsonSchema — the same
// call the codemode runtime makes, so this is what the model is handed. It
// exists for review and drift detection; it is NOT a second source of truth.
//
// These declarations are GUIDANCE, not a security boundary. The sandbox runs
// JavaScript and nothing stops model code calling a method the types forbid.
// The boundary is the Zod parse inside defineCapability().`;

/**
 * Namespaces whose model-facing declarations are hand-written, keyed by
 * namespace name.
 *
 * Exactly one entry, and it must stay exactly one. `files.publish` takes
 * `bytes: z.instanceof(Uint8Array)`, which has no JSON Schema — see the long
 * comment on `FILES_DECLARATIONS` itself for what each render path does with
 * that and why neither answer is good enough to show the model.
 *
 * The override lives here, in rendering, rather than on the connector: a
 * connector carries `instructions()` (model-facing guidance), not a `.d.ts`
 * block, and `CapabilityProvider.types` is deliberately not mapped across in
 * `buildConnectors`. Both render paths below therefore consult this table so
 * they agree byte for byte.
 */
const DECLARATION_OVERRIDES: Record<string, string | undefined> = {
  files: FILES_DECLARATIONS,
};

/**
 * The header plus one block per namespace, in the order given.
 *
 * A naive join is only valid because method names are globally unique: both
 * generators derive `type XInput` from the METHOD name with no namespace
 * prefix, so two `search` methods would emit two `type SearchInput` and the
 * joined file would not compile. That uniqueness has its own test — this
 * function depends on it rather than parsing TypeScript to work around it.
 */
function joinBlocks(blocks: string[]): string {
  return `${HEADER}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Render from the registry's Zod descriptors.
 *
 * Still the path that builds the `run_code` tool description at runtime
 * (`src/codemode/tool.ts`, `src/run/agent.ts`), where the caller holds a
 * registry and rendering must be synchronous. The committed artifact is
 * rendered by `renderDeclarationsFromConnectors` instead; the two are required
 * to produce identical bytes, which `pnpm codemode:dts:check` proves against
 * the committed file on every gate run.
 */
export function renderCapabilityDeclarations(
  registry: CapabilityRegistry,
): string {
  return joinBlocks(
    registry.map((provider) =>
      (
        DECLARATION_OVERRIDES[provider.name] ??
        provider.types ??
        generateTypes(provider.tools, provider.name)
      ).trim(),
    ),
  );
}

/**
 * Render from the connectors — the source of truth for the committed
 * `src/codemode/generated/capabilities.d.ts`.
 *
 * `describe()` is the same call the codemode runtime makes to learn what the
 * model may reach, so what this renders is what the model is actually handed,
 * not a parallel description of it. That is the whole point of moving the
 * artifact onto this path: a connector that silently degrades its schemas
 * (verified fact 8 — a raw Zod schema passes the package's JSON-Schema sniff
 * test and renders `type XInput = unknown`) now shows up as a diff in a
 * committed file instead of as a quietly worse API for the model.
 *
 * Async because `describe()` is; `Promise.all` keeps namespace order, which is
 * load-bearing — it is `PHASE_09_NAMESPACES` order, preserved by
 * `buildConnectors`, and it is the order the model reads its API in.
 *
 * Rendering never calls a capability: `describe()` reads descriptions and
 * schemas only, so this is safe to run from a build script against connectors
 * built over unreachable gateways.
 */
export async function renderDeclarationsFromConnectors(
  connectors: CodemodeConnector[],
): Promise<string> {
  const blocks = await Promise.all(
    connectors.map(async (connector) => {
      const { name, descriptors } = await connector.describe();
      const override = DECLARATION_OVERRIDES[name];
      if (override !== undefined) return override.trim();
      // `generateTypesFromJsonSchema` hard-codes `declare const codemode`;
      // the package's own `getTypeScriptTypes()` renames it exactly this way.
      return generateTypesFromJsonSchema(descriptors)
        .replace("declare const codemode", `declare const ${name}`)
        .trim();
    }),
  );
  return joinBlocks(blocks);
}
