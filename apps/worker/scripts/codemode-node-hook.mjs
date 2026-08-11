/**
 * Node cannot load `cloudflare:workers`, and `@cloudflare/codemode/ai` imports
 * it transitively (its executor module extends `RpcTarget`). The declaration
 * generator runs in plain Node, so without this hook it dies with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before rendering a single line.
 *
 * Only the class identities are needed — nothing in the render path constructs
 * or calls them. This stub never ships: it exists solely so a build script can
 * import the generator.
 */
const STUB = `
export class RpcTarget {}
export class WorkerEntrypoint {}
export class DurableObject {}
export class WorkflowEntrypoint {}
export const env = {};
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
