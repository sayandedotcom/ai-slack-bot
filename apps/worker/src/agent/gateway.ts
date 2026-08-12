import {
  GATEWAY_BACKOFF,
  GATEWAY_MAX_ATTEMPTS,
  GATEWAY_REQUEST_TIMEOUT_MS,
  GATEWAY_RETRY_DELAY_MS,
} from "./limits";

/**
 * The AI Gateway request headers, and nothing else.
 *
 * This module is deliberately incapable of handling a credential. It takes
 * opaque trusted IDs and small integers, and returns a header map. The
 * `cf-aig-authorization` secret is injected by the production composer in
 * `agent/model.ts`, SEPARATELY, so that every snapshot, log line, event and
 * error that touches this helper is provably secret-free (invariant 39). If a
 * future change makes this function take a token, that separation is gone and
 * the canary tests in `agent-gateway.test.ts` will say so.
 *
 * Pure module: no bindings, no clock, no network, no storage.
 */

/** The surfaces a run can originate from. An enum, so it cannot carry prose. */
export const GATEWAY_SURFACES = ["chat", "slack"] as const;

export type GatewaySurface = (typeof GATEWAY_SURFACES)[number];

/**
 * What may appear in `cf-aig-metadata`.
 *
 * Four opaque values, capped below at five. There is deliberately nowhere to
 * put a customer slug, an email, a Slack channel or thread coordinate, prompt
 * text, tool arguments or an error body: Gateway metadata is indexed and
 * retained by a third party, and none of those belong there. Correlation to a
 * real conversation happens through the provider/Gateway request IDs returned
 * per step, which this metadata deliberately omits.
 */
export type GatewayMetadata = {
  /** Opaque run ID. */
  run: string;
  /** Opaque generation ID. */
  generation: string;
  /** Claim number for this generation. A small integer. */
  attempt: number;
  surface: GatewaySurface;
};

export type GatewayHeaderInput = GatewayMetadata & {
  maxAttempts?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
};

/** At most five scalar values may be sent. Four are used; the fifth is headroom. */
export const GATEWAY_METADATA_MAX_VALUES = 5;

/** A metadata document larger than this is a bug, not a big ID. */
export const GATEWAY_METADATA_MAX_BYTES = 512;

/**
 * What an opaque ID may look like.
 *
 * Matches this system's own IDs (`run:<uuid>`, `gen:<uuid>`) and rejects the
 * shapes that indicate somebody put content here instead: whitespace, `@`,
 * `/`, `#`, quotes, and anything non-ASCII. This is a structural guard, not a
 * content filter — it cannot tell a safe ID from an unsafe one, only an ID
 * from a sentence.
 */
const OPAQUE_ID = /^[A-Za-z0-9:_.-]{1,128}$/;

export class GatewayMetadataError extends Error {
  readonly code = "invalid_gateway_metadata";

  constructor(message: string) {
    super(message);
    this.name = "GatewayMetadataError";
  }
}

function requireOpaqueId(field: string, value: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    // The offending value is NOT interpolated into the message. If it is a
    // prompt fragment or a credential, an error string is exactly the wrong
    // place for it to end up.
    throw new GatewayMetadataError(`gateway metadata ${field} must be an opaque id`);
  }
  return value;
}

function requireSmallInteger(field: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new GatewayMetadataError(`gateway metadata ${field} must be an integer in 0..${max}`);
  }
  return value;
}

/**
 * Build the metadata document. Separated from the header map so a test can
 * assert the bound and the exact key set without parsing a header string.
 */
export function buildGatewayMetadata(input: GatewayMetadata): GatewayMetadata {
  if (!GATEWAY_SURFACES.includes(input.surface)) {
    throw new GatewayMetadataError("gateway metadata surface must be a known surface");
  }

  const metadata: GatewayMetadata = {
    run: requireOpaqueId("run", input.run),
    generation: requireOpaqueId("generation", input.generation),
    attempt: requireSmallInteger("attempt", input.attempt, 1_000),
    surface: input.surface,
  };

  const keys = Object.keys(metadata);
  if (keys.length > GATEWAY_METADATA_MAX_VALUES) {
    throw new GatewayMetadataError(
      `gateway metadata may carry at most ${GATEWAY_METADATA_MAX_VALUES} values`,
    );
  }

  const encoded = JSON.stringify(metadata);
  if (new TextEncoder().encode(encoded).byteLength > GATEWAY_METADATA_MAX_BYTES) {
    throw new GatewayMetadataError("gateway metadata document is too large");
  }

  return metadata;
}

/**
 * The exact header map every provider call carries.
 *
 * Each value is explicit rather than left to the Gateway's dashboard defaults.
 * That is the point: a reviewed retry policy that a console toggle can change
 * is not a reviewed retry policy. `cf-aig-max-attempts` is the SAME number the
 * spend guard multiplies its worst-case exposure by, so the two cannot drift.
 *
 * `cf-aig-collect-log-payload: false` keeps prompts and completions out of
 * Gateway logs (invariant 26). It does NOT change Anthropic's own 30-day
 * retention, which is a separate control and a separate decision recorded in
 * the README security model.
 *
 * `cf-aig-skip-cache: true` disables GATEWAY RESPONSE caching, which must never
 * serve one customer's answer to another. It is unrelated to Anthropic PROMPT
 * caching, which is a provider feature this system uses deliberately and
 * measures through `cacheReadTokens`.
 */
export function gatewayHeaders(input: GatewayHeaderInput): Record<string, string> {
  const metadata = buildGatewayMetadata(input);
  const maxAttempts = requireSmallInteger(
    "maxAttempts",
    input.maxAttempts ?? GATEWAY_MAX_ATTEMPTS,
    10,
  );
  if (maxAttempts < 1) {
    throw new GatewayMetadataError("gateway max attempts must be at least 1");
  }
  const retryDelayMs = requireSmallInteger(
    "retryDelayMs",
    input.retryDelayMs ?? GATEWAY_RETRY_DELAY_MS,
    60_000,
  );
  const requestTimeoutMs = requireSmallInteger(
    "requestTimeoutMs",
    input.requestTimeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS,
    600_000,
  );

  return {
    "cf-aig-collect-log-payload": "false",
    "cf-aig-skip-cache": "true",
    "cf-aig-max-attempts": String(maxAttempts),
    "cf-aig-retry-delay": String(retryDelayMs),
    "cf-aig-backoff": GATEWAY_BACKOFF,
    "cf-aig-request-timeout": String(requestTimeoutMs),
    "cf-aig-metadata": JSON.stringify(metadata),
  };
}

/**
 * The header name that authenticates a request to the Gateway.
 *
 * Cloudflare documents TWO auth headers and they are not in conflict; they
 * belong to two different endpoint families:
 *
 *  - the REST API at `api.cloudflare.com/client/v4/accounts/.../ai/...` takes
 *    the standard `Authorization: Bearer <token>`;
 *  - the PROVIDER-NATIVE endpoints at `gateway.ai.cloudflare.com` take
 *    `cf-aig-authorization: Bearer <token>`, because `Authorization` on those
 *    routes already belongs to the upstream provider.
 *
 * This system routes Anthropic natively so the Anthropic SDK can keep sending
 * its own credential, which means the provider-native family and therefore
 * this header. `model.ts` enforces the matching host, so the header and the
 * endpoint cannot drift apart.
 *
 * Source: developers.cloudflare.com/ai-gateway/configuration/authentication/
 */
export const GATEWAY_AUTH_HEADER = "cf-aig-authorization";

/** The host whose endpoints `GATEWAY_AUTH_HEADER` is correct for. */
export const GATEWAY_PROVIDER_NATIVE_HOST = "gateway.ai.cloudflare.com";
