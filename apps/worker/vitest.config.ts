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
          // THE ONE THING THAT KEEPS THIS SUITE OFF THE REAL MODEL.
          //
          // The production ports no longer treat missing Gateway settings as
          // "park quietly" — plan lines 965-966 require absence to FAIL — so
          // the only thing that stops a RunDO in this pool from composing the
          // real Fable path is this explicit opt-out. Model work parks; every
          // projection runner is still installed and still exercised.
          //
          // It is not theoretical. The pool loads `.dev.vars`, which holds a
          // LIVE `ANTHROPIC_API_KEY`; the day somebody fills in
          // AI_GATEWAY_ANTHROPIC_URL and AI_GATEWAY_TOKEN there, an absence
          // check would have let the whole suite start spending money. This
          // line cannot be defeated that way — it is read before any
          // configuration is looked at.
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
