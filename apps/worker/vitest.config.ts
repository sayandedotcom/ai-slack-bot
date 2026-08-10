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
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
