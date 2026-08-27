import { CapabilityError } from "../gateways/errors";
import type { ArtifactPublisher, PublishedFile } from "../gateways/ports";

/**
 * Small on purpose. The Code Mode codec base64-encodes bytes into a JSON string
 * that crosses `ToolDispatcher` twice, so the wire cost is ~1.34x the payload
 * in each direction. Phase 19's large recordings have a trusted, non-Code-Mode
 * path to R2 precisely so nobody is tempted to raise this.
 */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * Content types the agent may publish, with the extension each one gets.
 *
 * An allowlist, and deliberately without `image/svg+xml`: an SVG is a script
 * container, and these objects are served from the app's own origin.
 */
const CONTENT_TYPES: Record<string, string> = {
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** Magic bytes for things that should never be published as an artifact. */
const EXECUTABLE_MAGIC: Array<[string, number[]]> = [
  ["a Windows executable", [0x4d, 0x5a]],
  ["an ELF binary", [0x7f, 0x45, 0x4c, 0x46]],
  ["a Mach-O binary", [0xcf, 0xfa, 0xed, 0xfe]],
  ["a script with a shebang", [0x23, 0x21]],
];

export type ArtifactConfig = {
  bucket: R2Bucket;
  /** Where objects are fetched from. The app's own origin, behind its auth. */
  baseUrl: string;
};

function invalid(reason: string): CapabilityError {
  return new CapabilityError("invalid_input", reason);
}

function assertPublishable(
  bytes: Uint8Array,
  contentType: string,
  filename: string
): string {
  const extension = CONTENT_TYPES[contentType];
  if (extension === undefined) {
    throw invalid(
      `"${contentType}" cannot be published. Allowed types: ${Object.keys(CONTENT_TYPES).join(", ")}.`
    );
  }
  if (bytes.byteLength === 0) {
    throw invalid("there are no bytes to publish.");
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw invalid(
      `the file is ${bytes.byteLength} bytes; the cap is ${MAX_ARTIFACT_BYTES}. Summarise or sample it instead.`
    );
  }
  // Path separators and control characters never reach an object key — the key
  // is derived, not taken from here — but a filename also becomes a download
  // name, so it is validated rather than merely ignored.
  if (/[/\\]/.test(filename)) {
    throw invalid("the filename cannot contain a path.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    throw invalid("the filename cannot contain control characters.");
  }
  if (!/^[\w][\w .()-]{0,199}$/.test(filename)) {
    throw invalid(
      "the filename may use letters, digits, spaces, dots, dashes, underscores and brackets only."
    );
  }
  for (const [label, magic] of EXECUTABLE_MAGIC) {
    if (magic.every((byte, i) => bytes[i] === byte)) {
      throw invalid(`that looks like ${label}, which cannot be published.`);
    }
  }
  return extension;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function makeArtifactPublisher(
  config: ArtifactConfig
): ArtifactPublisher {
  return {
    async publish(input): Promise<PublishedFile> {
      const extension = assertPublishable(
        input.bytes,
        input.contentType,
        input.filename
      );
      const sha256 = await sha256Hex(input.bytes);

      // Derived from the effect key, so a retry writes the same object rather
      // than a second one. 64 hex characters is also unguessable, which matters
      // because the object is served from the app's origin.
      const key = `${input.idempotencyKey}.${extension}`;

      await config.bucket.put(key, input.bytes as BufferSource, {
        httpMetadata: {
          contentType: input.contentType,
          // Never inline: an artifact is downloaded, not rendered in the app's
          // own origin, which is what would make a stored file into stored XSS.
          contentDisposition: `attachment; filename="${input.filename}"`,
        },
        customMetadata: {
          sha256,
          filename: input.filename,
          createdAt: new Date().toISOString(),
        },
      });

      // Only these three fields. No bucket handle, no account id, no prefix
      // beyond what the URL needs, no signed headers.
      return {
        url: `${config.baseUrl}/${key}`,
        size: input.bytes.byteLength,
        sha256,
      };
    },
  };
}

export { CONTENT_TYPES };
