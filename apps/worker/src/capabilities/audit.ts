/**
 * What a capability call records, and what is scrubbed out of it first.
 *
 * The sink never receives bytes, tokens, SQL credentials, HTTP headers or an
 * unredacted upstream trace. `src/redact.ts` is a different tool for a
 * different job — free-text prose on its way outbound; this file handles
 * structured arguments on their way into a durable record.
 */
import type { CapabilityErrorCode } from "../gateways/errors";
import type { JsonObject } from "../run/protocol";

export type CapabilityEventBase = {
  runId: string;
  turnId: string;
  /**
   * Identity of this nested call: `cap:{outer run_code tool call id}:{seq}`.
   *
   * The outer id is in the string, not just the sequence number. One agent loop
   * issues many `run_code` calls against one tool instance and every one starts
   * its sequence at 1 — so a bare `cap:1` collides across calls and makes the
   * audit trail unreconstructable exactly when something has gone wrong and
   * someone is trying to read it.
   */
  callId: string;
  /** 1-based position of this call within one `run_code` execution. */
  seq: number;
  namespace: string;
  method: string;
  at: number;
};

export type CapabilityStarted = CapabilityEventBase & {
  kind: "started";
  args: JsonObject | null;
};

export type CapabilityCompleted = CapabilityEventBase & {
  kind: "completed";
  durationMs: number;
  /** Size of the serialized result, or null when it is not serializable. */
  resultChars: number | null;
};

export type CapabilityFailed = CapabilityEventBase & {
  kind: "failed";
  durationMs: number;
  code: CapabilityErrorCode;
  /** Always the safe message. Never an upstream string. */
  message: string;
  retryable: boolean;
};

export type CapabilityEvent = CapabilityStarted | CapabilityCompleted | CapabilityFailed;

/** Where capability activity is recorded. */
export interface CapabilityAuditSink {
  started(event: CapabilityStarted): Promise<void>;
  completed(event: CapabilityCompleted): Promise<void>;
  failed(event: CapabilityFailed): Promise<void>;
}

/** Names whose *values* are redacted before they reach an audit record. */
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i;
/** Values that look like a credential regardless of what they are called. */
const SECRET_VALUE = /xox[baprs]-|^Bearer\s|^sk-|^lin_api_|^lsv2_|^sb_(secret|publishable)_/i;

/**
 * Strip credential-shaped arguments before they are recorded.
 *
 * The key is dropped along with the value, not blanked in place. A field
 * *named* `apiKey` is itself information — it fingerprints which credential an
 * adapter is passing around — and an audit record is durable. Only the count
 * survives, which is enough to notice that an adapter is passing something it
 * should not.
 *
 * Defense in depth only. The real boundary is that no credential is ever in
 * scope for a capability argument in the first place: gateways own secrets and
 * namespaces receive narrow interfaces. This exists so that a future adapter
 * getting that wrong leaves a redaction count rather than a durable plaintext
 * copy of a token.
 */
export function redactArgs(args: Record<string, unknown> | undefined): JsonObject | null {
  if (args === undefined) return null;

  const out: Record<string, unknown> = {};
  let redacted = 0;
  for (const [key, value] of Object.entries(args)) {
    const secretName = SECRET_KEY.test(key);
    const secretValue = typeof value === "string" && SECRET_VALUE.test(value);
    if (secretName || secretValue) {
      redacted += 1;
      continue;
    }
    out[key] = summarizeNonData(value);
  }
  if (redacted > 0) out.redactedFields = redacted;
  return out as JsonObject;
}

/**
 * Replace anything that is not plain JSON data with a description of it.
 *
 * This exists for `files.publish`, whose validated input carries a real
 * `Uint8Array`. An audit record is supposed to say what a call was ASKED to do,
 * and every consumer downstream bounds the string it stores — but bounding
 * happens after serialization, and `JSON.stringify` on a 5MB typed array first
 * materializes a ~67 MILLION character string (`{"0":1,"1":2,…}`) inside the
 * trusted parent Worker, taking over a second of CPU. The stored event would
 * look perfectly correct at 400 characters, which is exactly why nothing
 * downstream can catch this: the cost is entirely in a transient allocation
 * that model-authored code can trigger on demand, once per publish.
 *
 * This is also why the INPUT type is `Record<string, unknown>` while the output
 * is `JsonObject`: a capability's validated arguments are not all JSON — that
 * is the case this function exists for — and the JSON guarantee belongs to what
 * gets recorded, not to what arrives.
 *
 * A summary is also the more USEFUL audit line — "20 bytes of binary" is what a
 * reader wants, and the content hash is already an argument of the effect key.
 */
export function summarizeNonData(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "object") return value;

  if (ArrayBuffer.isView(value)) return `<binary: ${value.byteLength} bytes>`;
  if (value instanceof ArrayBuffer) return `<binary: ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(summarizeNonData);

  // A class instance is not data. Naming its constructor is enough for an audit
  // line and avoids walking an object whose size we do not control.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name;
    return `<${typeof name === "string" && name.length > 0 ? name : "object"}>`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = summarizeNonData(item);
  return out;
}

export function serializedLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : encoded.length;
  } catch {
    return null;
  }
}
