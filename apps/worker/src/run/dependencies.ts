/**
 * The one place `Env` meets the capability layer.
 *
 * `CapabilityDependencies` is deliberately NOT `Env` (see its doc comment in
 * `src/gateways/ports.ts`): a namespace that wanted a credential would have to
 * widen that type first, in a diff. This module is the boundary where the
 * credentials actually live, so it is the one place to look when asking what a
 * capability can reach.
 *
 * Every gateway is constructed per run, because most of them close over the
 * run's scope — a Slack gateway knows which thread it may post to, a Supabase
 * reader knows which scope it answers for, and a sandbox gateway knows which
 * container is this run's. None of them takes a destination as an argument.
 */
import {
  BETTERSTACK_UPTIME_ENDPOINT,
  makeBetterStackReader,
} from "../betterstack/client";
import { makeArtifactPublisher } from "../files/r2";
import type { CapabilityDependencies } from "../gateways/ports";
import type { RunScope } from "../gateways/scope";
import {
  makeGithubAuthSource,
  makeGithubGateway,
  resolveGithubConfig,
} from "../git/commit";
import { makeUserTokenSource } from "../identity/user-token";
import type { Env } from "../index";
import { makeLangSmithReader } from "../langsmith/client";
import { makeLinearGateway } from "../linear/client";
import { ZepMemory } from "../memory/zep";
import { makeSandboxGateway } from "../sandbox/gateway";
import { makeSlackGateway } from "../slack/gateway";
import { PRODUCTION_ALLOWLIST } from "../supabase/allowlist";
import { makeSupabaseReader } from "../supabase/reader";
import type { ApprovalPort } from "../approval/contracts";

export type DependencyOverrides = Partial<CapabilityDependencies>;

export function productionDependencies(
  env: Env,
  scope: RunScope,
  approval: ApprovalPort,
  overrides: DependencyOverrides = {}
): CapabilityDependencies {
  const clock = () => Date.now();
  const githubConfig = resolveGithubConfig(env);

  return {
    db: env.DB,
    // The identity source is what lets a reply go out as a real engineer. A
    // null one is not an error here: the gateway refuses at call time with
    // identity_unavailable, which is a message the model can act on.
    slack: makeSlackGateway(env.DB, scope, makeUserTokenSource(env)),
    memory: new ZepMemory(env.ZEP_API_KEY),
    linear: makeLinearGateway({
      apiKey: env.LINEAR_API_KEY,
      teamId: env.LINEAR_TEAM_ID,
      teamName: env.LINEAR_TEAM_NAME,
    }),
    supabase: makeSupabaseReader(
      {
        url: env.SUPABASE_URL,
        key: env.SUPABASE_KEY,
        allowlist: PRODUCTION_ALLOWLIST,
      },
      scope
    ),
    langsmith: makeLangSmithReader(
      {
        endpoint: env.LANGSMITH_ENDPOINT,
        apiKey: env.LANGSMITH_API_KEY,
        // The READ pin. This project shares a workspace with the live
        // zellify-prod project; repointing it there would let the agent
        // surface real customer traffic into a Slack reply.
        projectId: env.LANGSMITH_PROJECT_ID,
        projectName: env.LANGSMITH_PROJECT_NAME,
      },
      clock
    ),
    betterstack: makeBetterStackReader(
      {
        sqlEndpoint: env.BETTERSTACK_SQL_ENDPOINT,
        sqlUsername: env.BETTERSTACK_SQL_USERNAME,
        sqlPassword: env.BETTERSTACK_SQL_PASSWORD,
        logCollections:
          env.BETTERSTACK_LOG_SOURCE_IDS.split(",").filter(Boolean),
        uptimeToken: env.BETTERSTACK_UPTIME_TOKEN,
        uptimeEndpoint: BETTERSTACK_UPTIME_ENDPOINT,
      },
      clock
    ),
    files: makeArtifactPublisher({
      bucket: env.ARTIFACTS,
      baseUrl: env.ARTIFACTS_BASE_URL,
    }),
    approval,
    sandbox: makeSandboxGateway(env, scope.runId),
    github: makeGithubGateway(
      env,
      githubConfig,
      makeGithubAuthSource(env, githubConfig),
      clock
    ),
    clock,
    ...overrides,
  };
}
