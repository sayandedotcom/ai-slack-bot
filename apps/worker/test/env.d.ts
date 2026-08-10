import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// `env` from "cloudflare:test" is typed as Cloudflare.Env, which wrangler
// generates from wrangler.jsonc alone — it knows nothing about secrets or about
// the extra bindings vitest.config.ts injects through miniflare.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      SLACK_SIGNING_SECRET: string;
      SLACK_BOT_TOKEN: string;
    }
  }
}
