/**
 * Node cannot load `cloudflare:workers`, and `@cloudflare/codemode/ai` imports
 * it transitively (its executor module extends `RpcTarget`). The declaration
 * generator runs in plain Node, so without this hook it dies with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before rendering a single line.
 *
 * Only the class identities are needed — nothing in the render path constructs
 * or calls them. This stub never ships: it exists solely so a build script can
 * import the generator.
 *
 * `tracing` was added when `bindings/browser.ts` started importing a plain
 * constant (`MAX_RECORDING_TIMEOUT_MS`) from `sandbox/record.ts` — one
 * constant, owned by the layer that enforces it. That value import pulls in
 * `record.ts` → `sandbox/gateway.ts` → `@cloudflare/sandbox`'s `getSandbox`,
 * whose RPC control path does `import { tracing } from "cloudflare:workers"`
 * at the top level, so the generator now fails at load time on a name this
 * stub never had to provide before. `@cloudflare/sandbox` itself only ever
 * reads it as `tracing?.enterSpan?.bind(tracing)` — its own comment says it
 * falls back to running the wrapped function directly when the tracing API is
 * unavailable — so `undefined` is a correct value here, not a placeholder
 * standing in for real behavior the render path might invoke.
 */
const STUB = `
export class RpcTarget {}
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export const env = {};
export const tracing = undefined;
export default {};
`;

export function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return {
      url: `data:text/javascript,${encodeURIComponent(STUB)}`,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
