import {
  generateTypesFromJsonSchema,
  type CodemodeConnector,
  type JsonSchemaToolDescriptors,
} from "@cloudflare/codemode";
import type { CapabilityNamespace } from "./connector";
import { FILES_DECLARATIONS } from "./namespaces/files";
import { toJsonSchema } from "./schema";

/**
 * Pinned so the generated artifact records which generator produced it. The
 * emitted shape is compiled-output behaviour, not API shape, so a patch release
 * can change it without changing a single type.
 */
export const CODEMODE_VERSION = "0.5.1";

const HEADER = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate with:  pnpm capabilities:dts
// Verify with:       pnpm capabilities:dts:check
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
 * Render one namespace exactly the way a connector's `describe()` presents it.
 *
 * `FirefighterConnector.tools()` converts each Zod schema with `toJsonSchema`
 * and the base class then passes those straight through into `descriptors`, so
 * building the descriptors here from the same helper reproduces the connector
 * path byte for byte — without needing a connector instance, and therefore
 * without being async.
 */
function descriptorsFor(
  namespace: CapabilityNamespace
): JsonSchemaToolDescriptors {
  const descriptors: JsonSchemaToolDescriptors = {};
  for (const [method, tool] of Object.entries(namespace.tools)) {
    descriptors[method] = {
      description: tool.description,
      inputSchema: toJsonSchema(tool.input),
      outputSchema: tool.output ? toJsonSchema(tool.output) : undefined,
    };
  }
  return descriptors;
}

/**
 * Render from the registry, synchronously. This is the path that builds the
 * `run_code` tool description at runtime (`src/run/agent.ts`), where the caller holds a registry and cannot await.
 *
 * It goes through JSON Schema, NOT the AI SDK's Zod path, and that is
 * load-bearing rather than incidental. `generateTypes` runs its tools through
 * `asSchema`, whose `addAdditionalPropertiesToJsonSchema` unconditionally sets
 * `additionalProperties = false` on every object node — overwriting the value
 * schema of a `z.record(...)`. That is why `supabase.select` used to render as
 * `Promise<{}[]>`: not a limitation of the model-facing types, a mutation on
 * the way there.
 *
 * Keeping this in step with `renderDeclarationsFromConnectors` matters more
 * than it looks. `pnpm capabilities:dts:check` compares the CONNECTOR render
 * against the committed artifact; it says nothing about what the runtime
 * renders. If these two drifted, the committed `.d.ts` would be reviewed and
 * correct while the model was quietly handed something else — the one kind of
 * drift the check cannot see. `test/capabilities-dts.test.ts` asserts the two
 * render identical bytes.
 */
export function renderCapabilityDeclarations(
  namespaces: CapabilityNamespace[]
): string {
  return joinBlocks(
    namespaces.map((namespace) => {
      const override = DECLARATION_OVERRIDES[namespace.name];
      if (override !== undefined) return override.trim();
      return generateTypesFromJsonSchema(descriptorsFor(namespace))
        .replace("declare const codemode", `declare const ${namespace.name}`)
        .trim();
    })
  );
}

/**
 * Render from the connectors — the source of truth for the committed
 * `src/capabilities/generated/capabilities.d.ts`.
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
 * load-bearing — it is `CAPABILITY_NAMESPACES` order, preserved by
 * `buildConnectors`, and it is the order the model reads its API in.
 *
 * Rendering never calls a capability: `describe()` reads descriptions and
 * schemas only, so this is safe to run from a build script against connectors
 * built over unreachable gateways.
 */
export async function renderDeclarationsFromConnectors(
  connectors: CodemodeConnector[]
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
    })
  );
  return joinBlocks(blocks);
}
