import { CapabilityError } from "../gateways/errors";
import type { Env } from "../index";

/**
 * The dev-tier environment a Next.js dev server needs, supplied BY THE WORKER.
 *
 * Zellify's apps validate their environment with zod at startup and refuse to
 * boot without `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_API_KEY`,
 * `NEXT_PUBLIC_AUTH_URL` and the rest. In the monorepo those arrive through
 * `infisical run`; the container has no Infisical auth, so they arrive from one
 * Worker secret instead.
 *
 * WHY A BOOLEAN AND NOT A PARAMETER. Model-authored code asks for dev env by
 * setting `injectDevEnv: true`. It cannot name a variable, choose a value, read
 * one back, or print one — the difference between "the agent can start a dev
 * server" and "the agent can read our Supabase key" is exactly that the values
 * never enter its reach. So this module has no model-supplied input at all, and
 * no value appears in any return the model receives, any thrown message, or any
 * audit argument.
 *
 * WHAT PER-PROCESS DOES AND DOES NOT BUY. The record produced here rides on the
 * one `exec`/`startProcess` call that needs it; the container-wide environment
 * is never set, so the values are not waiting in every future `exec`. That is a
 * real narrowing and NOT a boundary. Two ways they are still reachable from
 * inside the container, both named rather than left to be discovered: while a
 * server runs, model-authored code could read `/proc/<pid>/environ`, and a
 * command run WITH the flag can simply print its own environment
 * (`exec({ cmd: "env", injectDevEnv: true })`). The exposure is the same one an
 * engineer running `pnpm dev` on a laptop has — dev-tier, read-scoped, and
 * disjoint from every write path — which is why it is written down in the
 * plan's "dev-env caveat" instead of being claimed away.
 *
 * WHAT CALLERS OWE. The record is for a process, not for a result. A caller
 * must not put it — or any part of it — in a capability return value, an
 * `auditedCapability` argument, or a log line. `devEnvKeyNames` exists so that
 * the useful half (which variables were supplied) is available without the
 * dangerous half.
 *
 * WHY PARSING IS STRICT AND EARLY. A malformed secret discovered inside a
 * container looks like a broken dev server: the process starts, zod rejects the
 * environment, and the agent spends turns debugging the monorepo. Failing here,
 * naming the offending KEY and the rule it broke, puts the error where the
 * mistake is. It never names the value: echoing a malformed secret into an
 * error string is precisely how one reaches a log.
 */

/**
 * What a variable name may look like.
 *
 * A name carrying `=`, whitespace or a NUL is not settable as an environment
 * variable — depending on the shell it is dropped or it corrupts the ones
 * around it. Refusing at parse time turns that into a readable message instead
 * of a dev server that boots without a variable nobody notices is missing.
 */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The prefix every failure carries, so an operator knows which secret to fix. */
const SECRET_NAME = "MONOREPO_DEV_ENV";

function unusable(reason: string): CapabilityError {
  return new CapabilityError("capability_unavailable", `${SECRET_NAME} ${reason}`);
}

/**
 * Parsed from the `MONOREPO_DEV_ENV` secret. Values never leave this module's
 * callers.
 *
 * Unset returns `{}` rather than throwing, deliberately. Most runs never start
 * a dev server, and a deployment without the secret must still boot containers,
 * exec, diff and open a PR. The failure belongs at the moment someone asks for
 * dev env there is none of — see `devEnvForProcess` — where the message can say
 * what was asked for and what was missing.
 */
export function devEnvFor(env: Env): Record<string, string> {
  const raw = env.MONOREPO_DEV_ENV?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never `err.message`: `JSON.parse` quotes the input it choked on, which
    // for this secret means quoting a credential into an error string.
    throw unusable("is not valid JSON. It must be a JSON object of string to string.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unusable(
      `must be a JSON object of string to string; this one is ${describe(parsed)}.`,
    );
  }

  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.length === 0) {
      throw unusable("has an entry with an empty name; every key must be a variable name.");
    }
    if (!VARIABLE_NAME.test(key)) {
      throw unusable(
        `entry "${key}" is not a usable variable name; names must match ${VARIABLE_NAME.source}.`,
      );
    }
    if (typeof value !== "string") {
      // The KEY and the offending TYPE, never the value — `describe` reports a
      // shape, and the one case it could quote (a string) is the legal one.
      throw unusable(`entry "${key}" is ${describe(value)}; every value must be a string.`);
    }
    entries.push([key, value]);
  }

  // `fromEntries` rather than assignment: `out["__proto__"] = v` sets the
  // prototype instead of a variable, and a secret is not the place to discover
  // that. `fromEntries` defines own properties, so `__proto__` stays a key.
  return Object.fromEntries(entries);
}

/** A shape, for an error message. Deliberately unable to report a value. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "a nested object";
  if (typeof value === "string") return "a string";
  return `a ${typeof value}`;
}

/**
 * Key names only — safe to log, safe to show the model.
 *
 * Names are useful diagnostics: "the dev server died and `SUPABASE_SECRET_API_KEY`
 * was not among the injected names" is an actionable sentence, and it carries
 * nothing. Sorted so a log line is stable across deployments and diffable.
 */
export function devEnvKeyNames(env: Env): string[] {
  return Object.keys(devEnvFor(env)).sort();
}

/**
 * The record a single spawned process gets, from the boolean the model set.
 *
 * `false` or omitted short-circuits before parsing: a run that never asks for
 * dev env must not be broken by a secret it does not use, and refusing to `exec
 * git log` because a JSON blob is malformed would be the wrong failure at the
 * wrong time.
 *
 * `true` with nothing configured throws rather than returning `{}`. The
 * alternative is a dev server that starts, fails zod validation and exits — a
 * failure the agent sees several turns later as "the monorepo is broken",
 * having spent a container's worth of time on it.
 */
export function devEnvForProcess(env: Env, injectDevEnv?: boolean): Record<string, string> {
  if (injectDevEnv !== true) return {};

  const devEnv = devEnvFor(env);
  if (Object.keys(devEnv).length === 0) {
    throw new CapabilityError(
      "capability_unavailable",
      `injectDevEnv was requested but ${SECRET_NAME} is not configured on this Worker, so there is nothing to inject. Run the command without dev env, or ask an operator to set the secret.`,
    );
  }
  return devEnv;
}
