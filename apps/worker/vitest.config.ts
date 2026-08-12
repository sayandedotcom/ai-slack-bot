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
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
