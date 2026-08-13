import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

// vitest-pool-workers v0.21 (vitest 4) replaced `defineWorkersConfig` +
// `test.poolOptions.workers` with the `cloudflareTest` Vite plugin. `singleWorker`
// no longer exists — the pool always runs one runtime per project.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SLACK_SIGNING_SECRET: "test-signing-secret",
          SLACK_BOT_TOKEN: "xoxb-test",
          // Newly necessary in Phase 10 Task 10.
          //
          // Until the run ports were wired, nothing in a test could reach the
          // memory queue on its own: a RunDO had no `memory_outbox` runner, so
          // every projection parked. It has one now, which is the whole point —
          // and it means a settled generation in any suite can send a real
          // queue message, whose consumer builds `new ZepMemory(env.ZEP_API_KEY)`.
          //
          // `.dev.vars` holds the LIVE key, so without this line a test run
          // could write episodes into the production memory graph. A fixture
          // value keeps the composition and the canary assertions working
          // (they only require a non-empty string) while making the write
          // impossible. Same reasoning as the two Slack fixtures above.
          ZEP_API_KEY: "zep-test-key",
          // THE LINE THAT KEEPS THIS SUITE OFF THE REAL MODEL, AND IT IS THIS
          // ONE — not the opt-out below it.
          //
          // The production ports no longer treat missing Gateway settings as
          // "park quietly": plan lines 965-966 require absence to FAIL, so
          // `productionRunPorts` installs the real continuation and lets
          // `createProductionModelFactory` refuse. Whether it refuses is decided
          // by these two settings AT CALL TIME, from the Durable Object's own
          // env (`do.ts`: `ports.continuation?.(this.ctx, this.env)`) — which is
          // to say, from THIS pool env, whatever env the port was composed from.
          //
          // That is why the opt-out below cannot carry the guarantee on its own.
          // Four sites in this repo install the production continuation from an
          // env they built themselves (`agent-ports.test.ts` twice, key-scoped;
          // `run-telemetry.test.ts` twice, GLOBALLY), and one of them loops up
          // to forty alarm dispatches waiting for a failure. None of them reads
          // `AGENT_MODEL_DISABLED` at all.
          //
          // It is not theoretical. The pool loads `.dev.vars`, which holds a
          // LIVE `ANTHROPIC_API_KEY`, and creating the private AI Gateway is a
          // KNOWN DEFERRED OPERATOR STEP for this repo — so "somebody fills in
          // AI_GATEWAY_ANTHROPIC_URL and AI_GATEWAY_TOKEN in `.dev.vars`" is the
          // expected next state of a developer machine, not a hypothetical. A
          // miniflare binding overrides `.dev.vars` (the same mechanism that
          // keeps ZEP_API_KEY above off the production memory graph), so an
          // EMPTY binding here means composition refuses with
          // `missing_gateway_url` before `createAnthropic` is ever reached, for
          // every env in the pool, forever.
          //
          // Pinned by `agent-ports.test.ts` > "binds the pool's Gateway settings
          // empty": it asserts `""` rather than falsiness, so deleting either
          // line fails the suite instead of silently re-inheriting `.dev.vars`.
          AI_GATEWAY_ANTHROPIC_URL: "",
          AI_GATEWAY_TOKEN: "",
          // The SECOND guard, and a narrower one: it stops a RunDO whose ports
          // were composed from the POOL env from installing a continuation at
          // all, so model work parks instead of failing and every projection
          // runner is still installed and still exercised. It does nothing for
          // the four sites above, which is why it is not the money guarantee.
          //
          // Read strictly (`1`/`true` only), so a typo fails loudly.
          //
          // Tests that want the continuation installed opt back IN explicitly,
          // by overriding this to "" in their own env object.
          AGENT_MODEL_DISABLED: "true",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
