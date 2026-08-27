import { z } from "zod";
import { sha256Bytes } from "../../gateways/hash";
import type { ClassifiedTool } from "../define";
import { runEffect } from "../effects";
import {
  auditedCapability,
  type BindingContext,
  effectDeps,
} from "../registry";

/**
 * Hand-written, and the only namespace that is.
 *
 * `generateTypes` renders through JSON Schema, which cannot express a
 * `Uint8Array`. Worse, it does not fail on one: an unrepresentable field
 * degrades the ENTIRE capability's input type to `unknown`, silently, so the
 * model would be told nothing at all about `contentType` or `filename`.
 * Verified against 0.5.1 with `z.instanceof`, `z.custom`, and `.meta()`
 * overrides — all three produce `type PublishInput = unknown`.
 *
 * The runtime schema below is still the boundary; this block only replaces what
 * the model is shown. `renderCapabilityDeclarations` has a test asserting no
 * OTHER namespace renders `= unknown`, so a future schema change cannot blank a
 * capability's guidance without failing the build.
 *
 * Binary genuinely survives the boundary: the package base64-tags Uint8Array
 * with `__codemode_binary_v1__` on the way out and decodes it back to a real
 * Uint8Array on the host. This is transport, not a lucky accident.
 */
export const FILES_DECLARATIONS = `type PublishInput = {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
}
type PublishOutput = {
    url: string;
    size: number;
    sha256: string;
}

declare const files: {
\t/**
\t * Publish bytes as a retrievable artifact and get back its address. This is the only way to return binary content.
\t */
\tpublish: (input: PublishInput) => Promise<PublishOutput>;
}`;

/**
 * The only path by which bytes leave the sandbox.
 *
 * `toSafeJson` refuses a binary final result on purpose, so a model that wants
 * to hand back an image or a dump has exactly one way to do it, and that way is
 * audited, size-bounded and produces a URL rather than an inline blob.
 */
export function makeFilesTools(
  ctx: BindingContext
): Record<string, ClassifiedTool> {
  return {
    publish: auditedCapability(ctx, "files", "publish", {
      effect: "external_write",
      description:
        "Publish bytes as a retrievable artifact and get back its address. This is the only way to return binary content.",
      input: z.strictObject({
        bytes: z.instanceof(Uint8Array),
        contentType: z.string().min(1).max(120),
        filename: z.string().min(1).max(200),
      }),
      output: z.strictObject({
        url: z.string(),
        size: z.number(),
        sha256: z.string(),
      }),
      run: async (input) => {
        // The CONTENT is part of the effect's identity, not just its name and
        // length. Without this hash, two different 4KB `evidence.png`s in one
        // turn share an effect key: the ledger replays the first one's URL for
        // the second, and the model — and then a customer — is handed the wrong
        // screenshot with no error anywhere. Hashing here rather than trusting
        // the publisher's returned digest, because the key has to exist BEFORE
        // the write it is meant to deduplicate.
        const sha256 = await sha256Bytes(input.bytes);
        // Through the ledger so the object key IS the effect key: a retry
        // writes the same object and returns the same URL rather than
        // scattering near-duplicate artifacts.
        return runEffect(
          effectDeps(ctx),
          ctx.scope,
          "files",
          "publish",
          {
            contentType: input.contentType,
            filename: input.filename,
            size: input.bytes.byteLength,
            sha256,
          },
          {
            execute: (idempotencyKey) =>
              ctx.deps.files.publish({
                bytes: input.bytes,
                contentType: input.contentType,
                filename: input.filename,
                idempotencyKey,
              }),
          }
        );
      },
    }),
  };
}
