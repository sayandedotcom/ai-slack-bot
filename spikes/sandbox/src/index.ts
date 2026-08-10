/**
 * Phase 00 · Sandbox spike
 *
 * Task 1 Step 5: prove the whole chain works before measuring anything.
 * Worker -> Sandbox DO -> container -> `echo hello` -> back through the Worker.
 *
 * Everything here is throwaway. It is committed because Phase 00's deliverable
 * is evidence, not a library.
 */
import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

/** One sandbox identity for the whole spike, so timings compare like for like. */
const SANDBOX_ID = "spike";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Must come first: preview-URL and tunnel traffic is routed here before any
    // application logic gets a look at the request.
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

    try {
      switch (url.pathname) {
        /** Task 1 Step 5 — the smoke test. */
        case "/hello": {
          const startedAt = Date.now();
          const result = await sandbox.exec("echo hello");
          return json({
            ok: result.exitCode === 0 && result.stdout.trim() === "hello",
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            wallClockMs: Date.now() - startedAt,
          });
        }

        /**
         * What the container actually is. Recorded in the findings so the
         * Phase 18 image is built against a known base rather than a guess.
         */
        case "/env": {
          const result = await sandbox.exec(
            "uname -a; echo '---'; node --version 2>/dev/null || echo 'no node'; " +
              "echo '---'; git --version 2>/dev/null || echo 'no git'; " +
              "echo '---'; nproc; echo '---'; free -m | head -2; " +
              "echo '---'; df -h / | tail -1",
          );
          return json({ stdout: result.stdout, stderr: result.stderr });
        }

        default:
          return json(
            { routes: ["/hello", "/env"] },
            404,
          );
      }
    } catch (err) {
      // Spike code: surface the real failure rather than a friendly 500, since
      // the failure mode IS the deliverable.
      return json(
        {
          error: String(err),
          name: err instanceof Error ? err.name : undefined,
          stack: err instanceof Error ? err.stack : undefined,
        },
        500,
      );
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
