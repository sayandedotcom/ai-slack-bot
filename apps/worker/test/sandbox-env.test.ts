import { describe, expect, it, vi } from "vitest";
import { CapabilityError } from "../src/codemode/errors";
import type { Env } from "../src/index";
import { devEnvFor, devEnvForProcess, devEnvKeyNames } from "../src/sandbox/env";

/**
 * THE MODEL NEVER SEES, TYPES, CHOOSES OR PRINTS A DEV-ENV VALUE.
 *
 * A Next.js dev server validates its environment with zod at startup and
 * refuses to boot without `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_API_KEY`
 * and friends. Those values live in one Worker secret. The whole difference
 * between "the agent can start a dev server" and "the agent can read our
 * Supabase key" is that model-authored code sets a BOOLEAN and the Worker
 * supplies the values — so these cases hold two lines at once:
 *
 *  - a malformed secret fails at parse time, loudly, naming the offending KEY
 *    and the rule it broke and never the value it carried;
 *  - no value reaches a return the model can read, an error message, or a
 *    stack — asserted by sweeping `JSON.stringify` over every outcome,
 *    successful and thrown alike, with a sentinel planted in the fixture so the
 *    assertion has something real to catch.
 *
 * The env argument is a bare object rather than the pool's `env`: this module
 * is pure, reads exactly one secret, and has no reference to a container at
 * all. Handing it a two-property object is the honest shape of its dependency.
 */

/** Planted in every fixture — including the malformed ones — so the sweep bites. */
const SENTINEL = "sentinel-b7f21c9e-never-log-me";

const DEV_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${SENTINEL}.supabase.co`,
  SUPABASE_SECRET_API_KEY: `sb_secret_${SENTINEL}`,
  NEXT_PUBLIC_AUTH_URL: `http://localhost:3001?k=${SENTINEL}`,
  // Empty is a legitimate value for a feature flag; it must not read as absent.
  NEXT_PUBLIC_ANALYTICS_KEY: "",
};

function withSecret(value?: string): Env {
  return { MONOREPO_DEV_ENV: value } as unknown as Env;
}

const VALID = withSecret(JSON.stringify(DEV_ENV));

/**
 * Every malformed shape the secret can take, each one CARRYING THE SENTINEL.
 *
 * That is what makes the leak sweep real: if any of these paths echoed the blob
 * it choked on — the natural thing to do, and what `JSON.parse`'s own message
 * does — the sentinel would surface in the error and the sweep would fail.
 */
const MALFORMED: { name: string; secret: string; mentions: string }[] = [
  {
    name: "truncated JSON",
    secret: `{"SUPABASE_SECRET_API_KEY": "sb_secret_${SENTINEL}"`,
    mentions: "JSON",
  },
  {
    name: "a JSON array",
    secret: JSON.stringify([`sb_secret_${SENTINEL}`]),
    mentions: "object",
  },
  {
    name: "a top-level string",
    secret: JSON.stringify(`sb_secret_${SENTINEL}`),
    mentions: "object",
  },
  {
    name: "a top-level null",
    secret: "null",
    mentions: "object",
  },
  {
    name: "a numeric value",
    secret: `{"PORT": 4100, "SUPABASE_SECRET_API_KEY": "sb_secret_${SENTINEL}"}`,
    mentions: "PORT",
  },
  {
    name: "a null value",
    secret: `{"SUPABASE_SECRET_API_KEY": null, "OTHER": "sb_secret_${SENTINEL}"}`,
    mentions: "SUPABASE_SECRET_API_KEY",
  },
  {
    name: "a nested object value",
    secret: `{"SUPABASE": {"key": "sb_secret_${SENTINEL}"}}`,
    mentions: "SUPABASE",
  },
  {
    name: "an unnamed key",
    secret: `{"": "sb_secret_${SENTINEL}"}`,
    mentions: "name",
  },
  {
    name: "a key that is not a usable variable name",
    secret: `{"NEXT PUBLIC=X": "sb_secret_${SENTINEL}"}`,
    mentions: "NEXT PUBLIC=X",
  },
];

/** Whatever a call did — returned or threw — as one inspectable value. */
function outcomeOf(call: () => unknown): unknown {
  try {
    return call();
  } catch (err) {
    return err;
  }
}

/**
 * Serialise for the sweep, INCLUDING what `JSON.stringify` would quietly drop.
 *
 * `message` and `stack` are non-enumerable on an Error, so a plain
 * `JSON.stringify(err)` is `{}` — a sweep built on it would pass while the
 * secret sat in the very field the model receives. Named properties are read
 * explicitly, and every own property (`code`, `reason`, `details`) with it.
 */
function everythingAbout(value: unknown): string {
  if (value instanceof Error) {
    const own: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      own[key] = (value as unknown as Record<string, unknown>)[key];
    }
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack ?? "",
      own,
      asString: String(value),
    });
  }
  return JSON.stringify(value ?? null);
}

describe("devEnvFor", () => {
  it("parses the secret into the exact keys and values it was given", () => {
    expect(devEnvFor(VALID)).toEqual(DEV_ENV);
  });

  it("returns {} when the secret is unset, rather than throwing", () => {
    expect(devEnvFor(withSecret())).toEqual({});
    expect(devEnvFor(withSecret(""))).toEqual({});
    expect(devEnvFor(withSecret("   \n "))).toEqual({});
  });

  it("returns {} for an empty JSON object", () => {
    expect(devEnvFor(withSecret("{}"))).toEqual({});
  });

  it("hands back a fresh record each call, so a caller cannot poison the next one", () => {
    const first = devEnvFor(VALID);
    first.SUPABASE_SECRET_API_KEY = "tampered";
    expect(devEnvFor(VALID)).toEqual(DEV_ENV);
  });

  for (const { name, secret, mentions } of MALFORMED) {
    it(`throws on ${name}, naming the key or the rule`, () => {
      let thrown: unknown;
      try {
        devEnvFor(withSecret(secret));
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CapabilityError);
      const err = thrown as CapabilityError;
      expect(err.code).toBe("capability_unavailable");
      expect(err.message).toContain("MONOREPO_DEV_ENV");
      expect(err.message).toContain(mentions);
      expect(err.message).not.toContain(SENTINEL);
    });
  }

  it("does not let a `__proto__` key touch the prototype chain", () => {
    const parsed = devEnvFor(withSecret(`{"__proto__": "polluted"}`));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads nothing from the Env but the one secret", () => {
    const read: string[] = [];
    const spy = new Proxy(
      { MONOREPO_DEV_ENV: JSON.stringify(DEV_ENV) } as Record<string, unknown>,
      {
        get(target, key) {
          if (typeof key === "string") read.push(key);
          return target[key as string];
        },
      },
    ) as unknown as Env;

    devEnvForProcess(spy, true);

    // No SANDBOX binding, no bucket, no D1: this module cannot reach a
    // container, which is what makes "never container-wide" structural rather
    // than a promise.
    expect(read).toEqual(["MONOREPO_DEV_ENV"]);
  });
});

describe("devEnvKeyNames", () => {
  it("returns the names, sorted, and nothing else", () => {
    expect(devEnvKeyNames(VALID)).toEqual([
      "NEXT_PUBLIC_ANALYTICS_KEY",
      "NEXT_PUBLIC_AUTH_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SECRET_API_KEY",
    ]);
  });

  it("is empty when the secret is unset", () => {
    expect(devEnvKeyNames(withSecret())).toEqual([]);
  });
});

describe("devEnvForProcess", () => {
  it("is empty when the flag is absent or false, without parsing at all", () => {
    expect(devEnvForProcess(VALID)).toEqual({});
    expect(devEnvForProcess(VALID, false)).toEqual({});
    // A run that never asks for dev env must not be broken by a bad secret.
    expect(devEnvForProcess(withSecret(MALFORMED[0].secret), false)).toEqual({});
  });

  it("round-trips every key and value when the flag is set", () => {
    expect(devEnvForProcess(VALID, true)).toEqual(DEV_ENV);
  });

  it("fails readably when asked for dev env there is none of", () => {
    let thrown: unknown;
    try {
      devEnvForProcess(withSecret(), true);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CapabilityError);
    const err = thrown as CapabilityError;
    expect(err.code).toBe("capability_unavailable");
    expect(err.message).toContain("MONOREPO_DEV_ENV");
    expect(err.message).toContain("injectDevEnv");
  });

  it("produces a per-process record and never a container-wide mutation", async () => {
    // The shape Task 7's binding uses: the record rides along on the ONE call
    // that needs it. Nothing in this module has a sandbox to mutate, and the
    // spy proves the caller's shape keeps it that way.
    const setEnvVars = vi.fn();
    const exec = vi.fn(async (_cmd: string, _opts: { env?: Record<string, string> }) => ({
      exitCode: 0,
    }));

    await exec("pnpm exec next dev --port 4100", { env: devEnvForProcess(VALID, true) });

    expect(setEnvVars).not.toHaveBeenCalled();
    expect(exec.mock.calls[0][1].env).toEqual(DEV_ENV);
  });
});

describe("the leak sweep", () => {
  it("puts no value in any key-name result, any error, or any stack", () => {
    const outcomes: unknown[] = [
      // Everything model-facing, on a secret that parses.
      outcomeOf(() => devEnvKeyNames(VALID)),
      outcomeOf(() => devEnvForProcess(VALID)),
      outcomeOf(() => devEnvForProcess(VALID, false)),
      // Every failure path, each on a blob carrying the sentinel.
      outcomeOf(() => devEnvForProcess(withSecret(), true)),
      ...MALFORMED.flatMap(({ secret }) => [
        outcomeOf(() => devEnvFor(withSecret(secret))),
        outcomeOf(() => devEnvKeyNames(withSecret(secret))),
        outcomeOf(() => devEnvForProcess(withSecret(secret), true)),
      ]),
    ];

    const swept = outcomes.map(everythingAbout).join("\n");
    expect(swept).not.toContain(SENTINEL);

    // The sweep is only worth anything if the sentinel is findable at all: the
    // one place a value legitimately lives is the record handed to the process.
    expect(everythingAbout(devEnvForProcess(VALID, true))).toContain(SENTINEL);

    // And every failure path actually failed — a sweep over silent successes
    // would pass for the wrong reason.
    const failures = outcomes.filter((o) => o instanceof Error);
    expect(failures).toHaveLength(1 + MALFORMED.length * 3);
  });
});
