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
      // `wrangler types` infers secrets from whatever .dev.vars happens to hold
      // locally, so these are declared here instead — the type must not depend
      // on which keys a given machine has filled in.
      ZEP_API_KEY: string;
      ANTHROPIC_API_KEY: string;
      // Bound EMPTY by vitest.config.ts so no env in this pool can compose a
      // real provider. Optional rather than `string` because a deployed Worker
      // genuinely may not have them — that absence is the failure plan lines
      // 965-966 are about, and `src/index.ts` must keep seeing it as possible.
      AI_GATEWAY_ANTHROPIC_URL?: string;
      AI_GATEWAY_TOKEN?: string;
    }
  }
}
