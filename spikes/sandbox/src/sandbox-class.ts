/**
 * Phase 00 · Sandbox spike — Task 4
 *
 * The credential-swap primitive, adapted from agent-os rather than discovered
 * (see docs/inspired-from-ronit.md §7).
 *
 * Ground truth, read from the installed .d.ts: `interceptHttps`, `sleepAfter`
 * and the static `outboundByHost` are NOT declared on @cloudflare/sandbox's
 * Sandbox. They are inherited from `Container` in @cloudflare/containers
 * (0.3.7), which is why grepping the sandbox package for them finds nothing.
 */
import { Sandbox as BaseSandbox, ContainerProxy } from "@cloudflare/sandbox";

/**
 * The SDK requires this to be exported from the Worker entrypoint so the
 * Sandbox DO can construct outbound-interception fetchers that reference it.
 * Undocumented outside a comment in the .d.ts; omitting it fails at runtime.
 */
export { ContainerProxy };

/**
 * A sentinel host, not a catch-all.
 *
 * Configuring ONLY `outboundByHost` — no static `outbound`, no
 * allowedHosts/deniedHosts — puts the SDK in per-host mode. Everything else
 * (R2, GitHub, npm, apt) flows direct through the container's network
 * namespace and never enters Worker fetch.
 *
 * That matters beyond tidiness: Worker fetch normalizes Content-Length on HEAD
 * responses, which broke agent-os's s3fs-on-R2 mount. Route the minimum.
 */
export const PROXY_HOST = "proxy.firefighter.local";

/** What the container is given instead of a credential. */
export const PLACEHOLDER_CREDENTIAL = "PLACEHOLDER_CREDENTIAL_NOT_A_SECRET";

/**
 * Long enough that a container cannot nap mid-repro. The SDK default is 10
 * minutes; a drill is timed by a human watching a Slack thread, and a sleeping
 * container reads as a hang. Revisit against the Task 2 timings.
 */
const SLEEP_AFTER = "45m";

export class Sandbox extends BaseSandbox<Env> {
  /**
   * Must stay `string | number` to match the base class. Narrowing it to
   * `string` breaks assignability to SandboxEnv<Sandbox<any>> — the namespace
   * generic is invariant, so a narrower property is just as incompatible as a
   * wider one, and the error surfaces confusingly at proxyToSandbox().
   */
  sleepAfter: string | number = SLEEP_AFTER;
  /** Without this, only http:// is routed through outbound. */
  interceptHttps = true;
}

/**
 * STATIC, assigned at module scope. The SDK reads it at construction time and
 * registers interceptOutboundHttps(host, ...) per key — assigning it inside the
 * constructor is too late.
 */
Sandbox.outboundByHost = {
  [PROXY_HOST]: async (request, env: Env) => {
    const incoming = request.headers.get("authorization") ?? "";
    const carriedPlaceholder = incoming.includes(PLACEHOLDER_CREDENTIAL);

    // The swap: the placeholder never leaves, the real value never enters.
    const outgoing = new Headers(request.headers);
    outgoing.set("authorization", `Bearer ${env.SPIKE_SECRET}`);

    // Prove the real credential actually reaches the wire by sending it to an
    // echo service and inspecting the reflection HERE, in the Worker.
    let egressCarriedRealCredential: boolean | string;
    try {
      const echo = await fetch("https://postman-echo.com/headers", {
        headers: outgoing,
      });
      const body = (await echo.json()) as { headers?: Record<string, string> };
      const seen = body.headers?.authorization ?? "";
      egressCarriedRealCredential = seen.includes(env.SPIKE_SECRET);
    } catch (err) {
      egressCarriedRealCredential = `echo unavailable: ${String(err)}`;
    }

    // The container is handed a verdict, never the reflection — echoing the
    // upstream response would leak the secret straight back inside and make
    // the test prove the opposite of what it claims.
    return Response.json({
      intercepted: true,
      containerSentPlaceholder: carriedPlaceholder,
      egressCarriedRealCredential,
    });
  },
};
