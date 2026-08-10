/**
 * Phase 00 · Sandbox spike
 *
 * Tasks 1-4. Throwaway code, committed as evidence for the AI-tool notes.
 *
 * Every timing route returns wall-clock milliseconds measured in the Worker,
 * because that is what the drill actually experiences — a human watching a
 * Slack thread does not care where the time went.
 */
import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";
import { PLACEHOLDER_CREDENTIAL, PROXY_HOST } from "./sandbox-class";

export { Sandbox, ContainerProxy } from "./sandbox-class";

/** One sandbox identity for the whole spike, so timings compare like for like. */
const SANDBOX_ID = "spike";

/**
 * Stand-in for the Zellify monorepo, which is still behind the invite.
 * Same shape as this repo: pnpm + turborepo + a Next.js dev server. What is
 * being measured is the PLATFORM's ceiling, not anyone's code.
 */
const TARGET_REPO = "https://github.com/shadcn-ui/ui.git";
const REPO_DIR = "/workspace/ui";

type Timed<T> = { ms: number; value: T };

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Must come first: preview-URL and tunnel traffic is routed here before any
    // application logic sees the request.
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);
    const sh = (cmd: string, timeoutMs = 900_000) =>
      sandbox.exec(cmd, { timeout: timeoutMs, cwd: "/workspace" });

    try {
      switch (url.pathname) {
        /** Task 1 Step 5 — the smoke test. */
        case "/hello": {
          const r = await timed(() => sandbox.exec("echo hello"));
          return json({
            ok: r.value.exitCode === 0 && r.value.stdout.trim() === "hello",
            stdout: r.value.stdout,
            wallClockMs: r.ms,
          });
        }

        /** What the container actually is, recorded so Phase 18 builds on fact. */
        case "/env": {
          const r = await sandbox.exec(
            "uname -a; echo '---'; node --version; echo '---'; git --version; " +
              "echo '---'; nproc; echo '---'; free -m | head -2; " +
              "echo '---'; df -h / | tail -1; echo '---'; " +
              "(pnpm --version || echo 'no pnpm'); echo '---'; " +
              "(chromium --version || chromium-browser --version || echo 'no chromium')",
          );
          return json({ stdout: r.stdout, stderr: r.stderr });
        }

        /**
         * Task 2 — the six numbers, one route each so a slow step can be
         * re-run without paying for the ones before it.
         *
         * Numbers 1 (cold boot) and 2 (clone) are here; 3-5 follow.
         */
        case "/t2/boot": {
          // Forces a fresh container, so this is a real cold boot rather than
          // a warm round trip.
          const r = await timed(() => sandbox.exec("echo booted"));
          return json({ step: "1. container cold boot", ms: r.ms, stdout: r.value.stdout });
        }

        case "/t2/clone": {
          const r = await timed(() =>
            sh(`rm -rf ${REPO_DIR} && mkdir -p /workspace && git clone --depth 1 ${TARGET_REPO} ${REPO_DIR}`),
          );
          return json({
            step: "2. git clone",
            ms: r.ms,
            exitCode: r.value.exitCode,
            stderr: r.value.stderr.slice(-500),
          });
        }

        case "/t2/install": {
          // ?offline=1 is number 6 — the warm-store re-measure that Phase 18
          // is budgeted against.
          const offline = url.searchParams.get("offline") === "1";
          const cmd = offline
            ? `cd ${REPO_DIR} && pnpm install --prefer-offline`
            : `cd ${REPO_DIR} && pnpm install`;
          const r = await timed(() => sh(cmd, 1_800_000));
          return json({
            step: offline ? "6. pnpm install --prefer-offline (warm store)" : "3. pnpm install (cold)",
            ms: r.ms,
            exitCode: r.value.exitCode,
            tail: r.value.stdout.slice(-800),
            stderr: r.value.stderr.slice(-800),
          });
        }

        /**
         * Task 2 number 4 and Task 3 Step 2 at once: a dev server started as a
         * long-running process, then exec calls run against the container while
         * it stays up. That is the shape of the entire repro loop.
         */
        case "/t2/devserver": {
          const port = Number(url.searchParams.get("port") ?? 3000);
          const started = await timed(async () => {
            const proc = await sandbox.startProcess(
              `cd ${REPO_DIR}/apps/www && pnpm dev --port ${port}`,
            );
            await proc.waitForPort(port, { timeout: 600_000 });
            return proc;
          });

          // Task 3 Step 2 — does the server survive concurrent exec?
          const during = await sandbox.exec("echo still-alive && ls /workspace");
          const processes = await sandbox.listProcesses();

          return json({
            step: "4. dev server up and serving",
            ms: started.ms,
            processId: started.value.id,
            execDuringServer: {
              exitCode: during.exitCode,
              stdout: during.stdout.trim(),
            },
            liveProcesses: processes.length,
          });
        }

        /** Task 3 Step 1 — a preview URL that is actually reachable. */
        case "/t3/tunnel": {
          const port = Number(url.searchParams.get("port") ?? 3000);
          const t = await timed(() => sandbox.tunnels.get(port));
          // Docs are explicit that exposePort() needs a custom domain with
          // wildcard DNS in production, while tunnels work on .workers.dev.
          const probe = await fetch(t.value.url, { method: "GET" }).then(
            (r) => ({ status: r.status, ok: r.ok }),
            (e) => ({ status: 0, error: String(e) }),
          );
          return json({ tunnel: t.value, ms: t.ms, reachable: probe });
        }

        /**
         * Task 3 Step 3 — diff extraction. THE WHOLE CREDENTIAL STORY FROM D5:
         * the container emits a diff, the Worker opens the PR. If a diff cannot
         * cross this boundary cleanly, Phase 20's design changes.
         */
        case "/t3/diff": {
          await sandbox.writeFile(
            `${REPO_DIR}/SPIKE_MARKER.md`,
            "# spike\n\nA planted edit, so there is something to diff.\n",
          );
          const r = await timed(() =>
            sh(`cd ${REPO_DIR} && git add -A && git diff --cached`),
          );
          const diff = r.value.stdout;
          return json({
            ms: r.ms,
            exitCode: r.value.exitCode,
            diffBytes: diff.length,
            looksLikeUnifiedDiff: diff.includes("diff --git") && diff.includes("+++"),
            diff: diff.slice(0, 1500),
          });
        }

        /**
         * Task 4 — the credential swap.
         *
         * The container sends a PLACEHOLDER to the sentinel host. The handler
         * substitutes the real value on egress and returns only a verdict, so
         * the secret is never visible inside the container.
         */
        case "/t4/credential-swap": {
          const r = await timed(() =>
            sandbox.exec(
              `curl -s -m 30 -H "authorization: Bearer ${PLACEHOLDER_CREDENTIAL}" ` +
                `https://${PROXY_HOST}/whoami`,
            ),
          );

          let handlerVerdict: unknown;
          try {
            handlerVerdict = JSON.parse(r.value.stdout);
          } catch {
            handlerVerdict = { unparsed: r.value.stdout.slice(0, 500) };
          }

          // The claim that matters: grep the container's own view for the real
          // secret. It must not be there.
          const leak = await sandbox.exec(
            `grep -rl "${env.SPIKE_SECRET}" /workspace /tmp /etc/environment 2>/dev/null | head -5; ` +
              `env | grep -c "${env.SPIKE_SECRET}" || true`,
          );

          return json({
            ms: r.ms,
            exitCode: r.value.exitCode,
            handlerVerdict,
            containerFilesystemLeak: leak.stdout.trim() || "(none)",
            note: "handlerVerdict.egressCarriedRealCredential is checked in the Worker, not echoed inside",
          });
        }

        /** Task 4 Step 3 — what sleepAfter is actually set to. */
        case "/t4/config": {
          return json({
            sleepAfter: (sandbox as unknown as { sleepAfter?: unknown }).sleepAfter ?? "unknown",
            interceptHttps: (sandbox as unknown as { interceptHttps?: unknown }).interceptHttps ?? "unknown",
            proxyHost: PROXY_HOST,
          });
        }

        default:
          return json(
            {
              routes: [
                "/hello",
                "/env",
                "/t2/boot",
                "/t2/clone",
                "/t2/install",
                "/t2/install?offline=1",
                "/t2/devserver",
                "/t3/tunnel",
                "/t3/diff",
                "/t4/credential-swap",
                "/t4/config",
              ],
            },
            404,
          );
      }
    } catch (err) {
      // Spike code: the failure mode IS the deliverable.
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
