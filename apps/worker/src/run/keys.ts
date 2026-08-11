/**
 * Origin keys and the ONE place `idFromName()` is called.
 *
 * A run has a stable origin key — `slack:{channel_id}:{thread_ts}` or
 * `chat:{uuid}` — and that key is the only input to the namespace. Keeping the
 * call in a single helper is what makes the key format survivable: the public
 * `runs.id` in dashboard URLs is a UUID, and the Worker looks the key up in D1
 * rather than letting a browser hand us a Durable Object name.
 */

export type RunOrigin = "slack" | "chat";

/** Slack channel ids are uppercase alphanumeric; this also excludes `:`. */
const SLACK_CHANNEL = /^[A-Z0-9]+$/;

/** Slack message timestamps are `seconds.microseconds`, e.g. 1720000000.123456. */
const SLACK_TS = /^\d{10}\.\d{6}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RunKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunKeyError";
  }
}

/**
 * A root message has no `thread_ts` — its own `ts` IS the thread. Every caller
 * must go through this before building a key, or a root message and its first
 * reply would land on two different Durable Objects.
 */
export function canonicalThreadTs(ts: string, threadTs: string | null | undefined): string {
  return threadTs ?? ts;
}

export function slackRunKey(channelId: string, threadTs: string): string {
  if (!SLACK_CHANNEL.test(channelId)) {
    throw new RunKeyError(`invalid slack channel id: ${JSON.stringify(channelId)}`);
  }
  if (!SLACK_TS.test(threadTs)) {
    throw new RunKeyError(`invalid slack thread ts: ${JSON.stringify(threadTs)}`);
  }
  return `slack:${channelId}:${threadTs}`;
}

export function chatRunKey(chatId: string): string {
  if (!UUID.test(chatId)) {
    throw new RunKeyError(`chat run id must be a uuid: ${JSON.stringify(chatId)}`);
  }
  return `chat:${chatId}`;
}

/**
 * Re-validates a key that has already been built (or read back from D1) before
 * it names an object. Cheap, and it means a corrupted `runs.key` row cannot
 * silently create an anonymous Durable Object.
 */
export function assertRunKey(key: string): string {
  const [origin, ...rest] = key.split(":");
  if (origin === "slack") {
    if (rest.length !== 2) throw new RunKeyError(`malformed slack key: ${JSON.stringify(key)}`);
    return slackRunKey(rest[0], rest[1]);
  }
  if (origin === "chat") {
    if (rest.length !== 1) throw new RunKeyError(`malformed chat key: ${JSON.stringify(key)}`);
    return chatRunKey(rest[0]);
  }
  throw new RunKeyError(`unknown run key origin: ${JSON.stringify(key)}`);
}

export function runOriginOf(key: string): RunOrigin {
  assertRunKey(key);
  return key.startsWith("slack:") ? "slack" : "chat";
}

/**
 * The only `idFromName()` call in the codebase. Generic over the DO class so
 * this module never imports the Durable Object implementation — keys stay pure
 * and testable against a fake namespace.
 *
 * `Rpc` is a global ambient namespace from worker-configuration.d.ts. It is NOT
 * exported by "cloudflare:workers"; importing it from there typechecks in the
 * pool-workers .d.ts but not in application code.
 */
export function runStubForKey<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  namespace: DurableObjectNamespace<T>,
  key: string,
): DurableObjectStub<T> {
  return namespace.get(namespace.idFromName(assertRunKey(key)));
}
