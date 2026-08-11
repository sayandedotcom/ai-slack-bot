import { generateTypes } from "@cloudflare/codemode/ai";
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
// Rendered from the real Zod schemas in src/codemode/bindings/ by
// @cloudflare/codemode@${CODEMODE_VERSION}'s generateTypes. This file exists for
// review and drift detection; it is NOT a second source of truth, and the tool
// description the model actually sees comes from the same render function.
//
// These declarations are GUIDANCE, not a security boundary. The sandbox runs
// JavaScript and nothing stops model code calling a method the types forbid.
// The boundary is the Zod parse inside defineCapability().`;

/**
 * Render one declaration block per namespace and join them in registry order.
 *
 * A naive join is only valid because method names are globally unique:
 * `generateTypes` derives `type XInput` from the METHOD name with no namespace
 * prefix, so two `search` methods would emit two `type SearchInput` and the
 * joined file would not compile. That uniqueness has its own test — this
 * function depends on it rather than parsing TypeScript to work around it.
 */
export function renderCapabilityDeclarations(
  registry: CapabilityRegistry,
): string {
  const blocks = registry.map((provider) =>
    (provider.types ?? generateTypes(provider.tools, provider.name)).trim(),
  );
  return `${HEADER}\n\n${blocks.join("\n\n")}\n`;
}
