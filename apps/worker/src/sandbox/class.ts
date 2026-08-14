/**
 * Phase 18 Task 3 — the Tier 2 container class and the git credential swap.
 *
 * Adapted from the deployed spike (`spikes/sandbox/src/sandbox-class.ts`) and
 * from agent-os (`docs/inspired-from-ronit.md` §7), not written from memory.
 *
 * Ground truth, read from the installed `.d.ts` rather than the docs pages:
 * `interceptHttps`, `sleepAfter` and the static `outboundByHost` are NOT
 * declared on `@cloudflare/sandbox`'s `Sandbox`. They are inherited from
 * `Container` in `@cloudflare/containers` (0.3.7), which is why grepping the
 * sandbox package for them finds nothing and reads as "these were removed".
 */
import { ContainerProxy, Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import type { Env } from "../index";

/**
 * The SDK requires this to be exported from the WORKER ENTRYPOINT so the
 * Sandbox DO can construct outbound-interception fetchers that reference it
 * (`ctx.exports.ContainerProxy`). Omitting it fails at RUNTIME, not at build
 * time, and the requirement is stated only in a comment inside the `.d.ts`.
 * Re-exported here so `src/index.ts` gets both names from one import.
 */
export { ContainerProxy };

/**
 * The sentinel host, not a catch-all.
 *
 * The container's git remote is `https://git.firefighter.local/<slug>.git`.
 * That host resolves nowhere; it exists so exactly one hostname enters Worker
 * fetch, where the handler below rewrites it to github.com and attaches the
 * real credential. The container is never given a credential to lose.
 *
 * MUST equal the `SANDBOX_GIT_HOST` var in wrangler.jsonc. It is duplicated as
 * a module constant because `static outboundByHost` is a registry the SDK
 * reads at DO construction, keyed by hostname — there is no `env` in scope at
 * that point, so the key cannot be computed from a binding. `assertGitSentinel`
 * below is how the two are kept honest; the var is what the *container* is
 * configured with, this constant is what the *Worker* intercepts.
 */
export const GIT_SENTINEL_HOST = "git.firefighter.local";

/**
 * The one repository the sentinel will proxy for.
 *
 * The PAT is already fine-grained (this repo, Contents: read-only), so this is
 * defence in depth rather than the only guard — but without it, model-authored
 * code inside the container could point any git command at the sentinel and
 * borrow our credential for a different repository. The path pin costs one
 * comparison and removes that entirely.
 */
export const MONOREPO_SLUG = "Zellify/web2app-rebuild";

/** What the container's git config carries in place of a credential. */
export const PLACEHOLDER_CREDENTIAL = "PLACEHOLDER_CREDENTIAL_NOT_A_SECRET";

/**
 * Long enough that a container cannot nap mid-repro. The SDK default is 10
 * minutes; a drill is timed by a human watching a Slack thread, and a sleeping
 * container reads as a hang. Overridable by the `SANDBOX_SLEEP_AFTER` var so
 * the number can be retuned against Task 1's measurements without a code
 * change. `sleepAfter` is read lazily by `renewActivityTimeout()`, so setting
 * it as a field initializer (after the base constructor) is effective.
 */
const DEFAULT_SLEEP_AFTER = "45m";

/**
 * `env` is typed non-optional but read defensively: this runs in a FIELD
 * INITIALIZER, which fires after the base constructor has assigned `this.env`.
 * That ordering is correct, and it is also the one assumption here whose
 * failure would take the Durable Object down at construction rather than at
 * the call site — cheap to make impossible.
 *
 * Note for the lifecycle: `getSandbox(..., { sleepAfter })` is applied by the
 * Container constructor and is therefore OVERWRITTEN by this field. This is
 * the single place the value is decided.
 */
function sleepAfterFrom(env: Env | undefined): string | number {
  const configured = env?.SANDBOX_SLEEP_AFTER?.trim();
  return configured ? configured : DEFAULT_SLEEP_AFTER;
}

/**
 * Fails loudly if the container's configured git host is not the one this
 * module intercepts. A mismatch is silent otherwise: the container's git
 * remote simply resolves nowhere and every fetch dies with a DNS error a long
 * way from the cause. Callers that build the remote URL (the lifecycle) should
 * call this first.
 */
export function assertGitSentinel(env: Env): string {
  const configured = env.SANDBOX_GIT_HOST?.trim();
  if (configured && configured !== GIT_SENTINEL_HOST) {
    throw new Error(
      `SANDBOX_GIT_HOST is "${configured}" but the outbound interceptor is registered for "${GIT_SENTINEL_HOST}". ` +
        "The var and src/sandbox/class.ts must name the same host.",
    );
  }
  return GIT_SENTINEL_HOST;
}

export class Sandbox extends BaseSandbox<Env> {
  /**
   * Must stay `string | number` to match the base class. Narrowing it to
   * `string` breaks assignability to `SandboxEnv<Sandbox<any>>` — the namespace
   * generic is invariant, so a narrower property is just as incompatible as a
   * wider one, and the error surfaces confusingly at `proxyToSandbox()`.
   */
  sleepAfter: string | number = sleepAfterFrom(this.env);
  /** Without this, only `http://` is routed through outbound. */
  interceptHttps = true;
}

/**
 * The credential swap: the placeholder never leaves the Worker's inbox, the
 * real PAT never enters the container.
 *
 * STATIC, assigned at module scope. The SDK reads it when the DO is
 * constructed and registers `interceptOutboundHttps(host, ...)` per key;
 * assigning it inside a constructor is too late.
 *
 * We use the static registry rather than the newer per-instance
 * `setOutboundByHost()` deliberately, and the reason is not preference — it is
 * read out of `@cloudflare/containers` 0.3.7's own source.
 * `Container.hasMutableOutboundConfiguration()` returns true as soon as ONE
 * runtime host override exists, and `shouldInterceptAllOutbound()` ORs that
 * in, so a single `setOutboundByHost()` call promotes the container to
 * intercept-ALL and (per the SDK's own comment) "keeps it there until the
 * instance restarts". That is exactly the mode this design must avoid.
 *
 * Configuring ONLY `outboundByHost` — no static `outbound`, no
 * `allowedHosts`/`deniedHosts`, no runtime override — keeps the SDK in
 * per-host mode. Everything else (R2, npm, apt, and github.com reached
 * directly) flows through the container's own network namespace and never
 * enters Worker fetch. That matters beyond tidiness: Worker fetch normalizes
 * `Content-Length` on HEAD responses, which broke agent-os's s3fs-on-R2 mount.
 * Route the minimum.
 */
Sandbox.outboundByHost = {
  [GIT_SENTINEL_HOST]: async (request: Request, env: Env): Promise<Response> => {
    const pat = env.MONOREPO_PAT;
    if (!pat) {
      // Naming the missing secret, never a value. Absence is not a mode: a
      // fetch that quietly proceeds unauthenticated 404s on a private repo and
      // reads as "the branch is gone".
      return Response.json(
        { code: "configuration_incomplete", message: "MONOREPO_PAT is not set on this Worker" },
        { status: 503 },
      );
    }

    const incoming = new URL(request.url);
    if (!isMonorepoPath(incoming.pathname)) {
      // The sentinel is a credential for one repository, not a general
      // authenticated GitHub proxy.
      return Response.json(
        { code: "forbidden_repo", message: `the sentinel host only proxies ${MONOREPO_SLUG}` },
        { status: 403 },
      );
    }

    const target = new URL(incoming.pathname + incoming.search, "https://github.com");

    const outgoing = new Request(target, request);
    // Overwrite rather than append: whatever the container sent (the
    // placeholder, or nothing) is discarded here and never reaches the wire.
    // `x-access-token` is GitHub's username convention for a token used as a
    // Basic password over https git.
    outgoing.headers.set("authorization", `Basic ${btoa(`x-access-token:${pat}`)}`);

    // Passed through unchanged: git needs the real bytes, and GitHub's
    // response does not carry the credential back. (The spike returned a
    // synthesised verdict instead, because there the upstream was an echo
    // service reflecting the secret.)
    return fetch(outgoing);
  },
};

/**
 * `/Zellify/web2app-rebuild/info/refs` and `/Zellify/web2app-rebuild.git/…`
 * are both legitimate git URL shapes, so match the slug and then require a
 * boundary — not a bare `startsWith`, which would also accept
 * `/Zellify/web2app-rebuild-secrets`.
 */
function isMonorepoPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  const slug = `/${MONOREPO_SLUG.toLowerCase()}`;
  if (!lower.startsWith(slug)) return false;
  const rest = lower.slice(slug.length);
  return rest === "" || rest === ".git" || rest.startsWith("/") || rest.startsWith(".git/");
}
