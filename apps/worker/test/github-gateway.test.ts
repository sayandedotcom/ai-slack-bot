import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertIdentity } from "../src/db/identities";
import {
  type GithubShipConfig,
  makeGithubAuthSource,
  makeGithubGateway,
  resolveGithubConfig,
} from "../src/git/commit";
import { importIdentityKey, seal } from "../src/identity/crypto";
import type { Env } from "../src/index";
import { MONOREPO_SLUG } from "../src/sandbox/class";
import { captureDiff } from "../src/sandbox/diff";

const worker = env as unknown as Env;

const IDENTITY_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff))
);
const NOW = Date.parse("2026-08-15T00:00:00Z");

const ORIGIN = "https://api.github.com";

type Call = {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
};
let calls: Call[] = [];

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new Headers(init?.headers ?? {}))
    out[name.toLowerCase()] = value;
  return out;
}

type Route = {
  match: (url: string, method: string) => boolean;
  respond: (
    url: string,
    body: unknown
  ) => { status: number; body: unknown; headers?: Record<string, string> };
};

/** Maps a URL (matched by inclusion) to a canned response, in order tried. */
function stubGithub(routes: Route[]) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: target, method, body, headers: headersOf(init) });
    const route = routes.find((r) => r.match(target, method));
    if (!route) throw new Error(`no stub route for ${method} ${target}`);
    const { status, body: respBody, headers } = route.respond(target, body);
    return new Response(JSON.stringify(respBody), { status, headers });
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // Shared D1, no isolatedStorage: a github row left here would make another
  // suite's "nobody connected" case find a speaker.
  await env.DB.prepare(
    "DELETE FROM identities WHERE provider = 'github'"
  ).run();
});

function baseConfig(
  overrides: Partial<GithubShipConfig> = {}
): GithubShipConfig {
  return {
    repo: "Zellify/web2app-rebuild",
    headRepo: "Zellify/web2app-rebuild",
    base: "staging",
    author: "worker-pat",
    ...overrides,
  };
}

/* ---------------------------------------------------------- Step 1: auth -- */

describe("auth + config", () => {
  it("worker-pat resolves env.MONOREPO_PAT", async () => {
    const testEnv = {
      ...worker,
      MONOREPO_PAT: "ghp_worker_pat_token",
    } as unknown as Env;
    const config = baseConfig({ author: "worker-pat" });
    const auth = makeGithubAuthSource(testEnv, config);
    expect(await auth.token(NOW)).toEqual({ token: "ghp_worker_pat_token" });
  });

  it("worker-pat resolves null when MONOREPO_PAT is unset", async () => {
    const testEnv = { ...worker, MONOREPO_PAT: undefined } as unknown as Env;
    const config = baseConfig({ author: "worker-pat" });
    const auth = makeGithubAuthSource(testEnv, config);
    expect(await auth.token(NOW)).toBeNull();
  });

  it("on-duty resolves a connected fire-fighter's decrypted github identity", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const key = await importIdentityKey(IDENTITY_KEY);
    // No shift: the speaker is the first fire-fighter in roster order who has
    // connected GitHub (src/identity/speaker.ts). Seed the LAST so the case
    // proves "connected" is what counts, not position.
    const { FIREFIGHTERS } = await import("../src/access/roster");
    const email = FIREFIGHTERS[FIREFIGHTERS.length - 1]!;

    await upsertIdentity(
      testEnv.DB,
      {
        email,
        provider: "github",
        externalId: "octo-speaker",
        scopes: "repo",
        tokenCiphertext: await seal(key, "gho_on_duty_token"),
        connectedAt: NOW,
      },
      NOW
    );

    const config = baseConfig({ author: "on-duty" });
    const auth = makeGithubAuthSource(testEnv, config);
    expect(await auth.token(NOW)).toEqual({ token: "gho_on_duty_token" });
  });

  it("on-duty resolves null when no fire-fighter has connected github", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const config = baseConfig({ author: "on-duty" });
    const auth = makeGithubAuthSource(testEnv, config);
    expect(await auth.token(NOW)).toBeNull();
  });

  it("a null auth source produces capability_unavailable naming the fix (worker-pat)", async () => {
    const testEnv = { ...worker, MONOREPO_PAT: undefined } as unknown as Env;
    const config = baseConfig({ author: "worker-pat" });
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(gateway.findPR("some-branch")).rejects.toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("set MONOREPO_PAT"),
    });
  });

  it("a null auth source produces capability_unavailable naming the fix (on-duty)", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const config = baseConfig({ author: "on-duty" });
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => Date.parse("2027-02-01T00:00:00Z")
    );
    await expect(gateway.findPR("some-branch")).rejects.toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("connect GitHub on the dashboard"),
    });
  });

  it("refuses a configured base of dev, by name, at construction", () => {
    const testEnv = { ...worker, MONOREPO_PAT: "x" } as unknown as Env;
    const config = baseConfig({ base: "dev" });
    expect(() =>
      makeGithubGateway(
        testEnv,
        config,
        makeGithubAuthSource(testEnv, config),
        () => NOW
      )
    ).toThrow(/dev/);
  });

  it("refuses an unrecognised GITHUB_AUTHOR by name, at config time", () => {
    // The documented handover is "flip one var to on-duty". A typo that
    // coerces to `worker-pat` opens PRs under the wrong identity with no
    // signal at deploy time — observable only after a PR already exists.
    for (const bad of [
      "onduty",
      "On-Duty",
      "on-duty!",
      "worker_pat",
      "nobody",
    ]) {
      const testEnv = { ...worker, GITHUB_AUTHOR: bad } as unknown as Env;
      expect(() => resolveGithubConfig(testEnv)).toThrow(/GITHUB_AUTHOR/);
    }
  });

  it("accepts both documented GITHUB_AUTHOR values, and treats absent/empty as the documented default", () => {
    expect(
      resolveGithubConfig({
        ...worker,
        GITHUB_AUTHOR: "on-duty",
      } as unknown as Env).author
    ).toBe("on-duty");
    expect(
      resolveGithubConfig({
        ...worker,
        GITHUB_AUTHOR: "worker-pat",
      } as unknown as Env).author
    ).toBe("worker-pat");
    // wrangler.jsonc may legitimately omit the var entirely.
    expect(
      resolveGithubConfig({
        ...worker,
        GITHUB_AUTHOR: undefined,
      } as unknown as Env).author
    ).toBe("worker-pat");
    expect(
      resolveGithubConfig({ ...worker, GITHUB_AUTHOR: "   " } as unknown as Env)
        .author
    ).toBe("worker-pat");
    // Surrounding whitespace is trimmed, exactly as before — that is not junk.
    expect(
      resolveGithubConfig({
        ...worker,
        GITHUB_AUTHOR: " on-duty ",
      } as unknown as Env).author
    ).toBe("on-duty");
  });

  it("defaults the repo slug to MONOREPO_SLUG when GITHUB_REPO is absent", () => {
    const testEnv = {
      ...worker,
      GITHUB_REPO: undefined,
      GITHUB_HEAD_REPO: undefined,
      GITHUB_BASE: undefined,
      GITHUB_AUTHOR: undefined,
    } as unknown as Env;
    const config = resolveGithubConfig(testEnv);
    expect(config.repo).toBe(MONOREPO_SLUG);
    expect(config.headRepo).toBe(MONOREPO_SLUG);
    expect(config.base).toBe("staging");
    expect(config.author).toBe("worker-pat");
  });
});

/* ----------------------------------------------------- Step 2: write path -- */

// A REAL sha shape: 40 lowercase hex. `openPR` interpolates this value into
// a query string and a URL path, and now refuses anything that is not this
// shape, so the fixture has to be the real thing rather than 39 characters
// that merely look like it.
const BASE_SHA = "abc123def456abc123def456abc123def456abcd";
const TOKEN = "ghp_test_token";

const SIMPLE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line two, fixed
 line three
`;

/** One delete (no context lines -- the whole file is removed) and one create, executable. */
const MULTI_CHANGE_PATCH = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line one
-line two
-line three
diff --git a/scripts/run.sh b/scripts/run.sh
new file mode 100755
index 0000000..2222222
--- /dev/null
+++ b/scripts/run.sh
@@ -0,0 +1,2 @@
+#!/bin/sh
+echo hi
`;

/** A patch whose touched path traverses out of the repo -- must be refused before any fetch. */
const TRAVERSAL_PATCH = `diff --git a/../../etc/passwd b/../../etc/passwd
index 1111111..2222222 100644
--- a/../../etc/passwd
+++ b/../../etc/passwd
@@ -1,1 +1,1 @@
-root:x:0:0
+root:x:0:1
`;

function testEnvWithPat(overrides: Record<string, unknown> = {}): Env {
  return { ...worker, MONOREPO_PAT: TOKEN, ...overrides } as unknown as Env;
}

async function seedDiff(
  testEnv: Env,
  patch = SIMPLE_PATCH,
  baseSha = BASE_SHA
): Promise<string> {
  const result = await captureDiff(
    testEnv,
    `run_${crypto.randomUUID()}`,
    patch,
    baseSha
  );
  if (result.diffRef === null) throw new Error("expected a diffRef");
  return result.diffRef;
}

function contentOf(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

/** Finding 4's guard is a READ that runs before every write, so every route table needs it. */
function compareRoute(repo: string, status = "behind"): Route {
  return {
    match: (url: string, method: string) =>
      method === "GET" && url.includes(`/repos/${repo}/compare/`),
    respond: () => ({
      status: 200,
      body: { status, ahead_by: status === "behind" ? 0 : 2, behind_by: 3 },
    }),
  };
}

/** A route table covering the whole openPR sequence for the happy path. */
function happyPathRoutes(opts: {
  headRepo: string;
  repo: string;
  branch: string;
  base: string;
  existingPr?: { number: number; html_url: string } | null;
}): Route[] {
  const { headRepo, repo, branch, base, existingPr = null } = opts;
  return [
    {
      // Finding 4's containment guard: `compare/<base>...<baseSha>`.
      match: (url: string, method: string) =>
        method === "GET" && url.includes(`/repos/${repo}/compare/`),
      respond: () => ({
        status: 200,
        body: { status: "behind", ahead_by: 0, behind_by: 4 },
      }),
    },
    {
      match: (url: string, method: string) =>
        method === "GET" && url.includes(`/repos/${headRepo}/contents/`),
      respond: () => ({
        status: 200,
        body: {
          content: contentOf("line one\nline two\nline three\n"),
          encoding: "base64",
        },
      }),
    },
    {
      match: (url: string, method: string) =>
        method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/blobs`,
      respond: () => ({ status: 201, body: { sha: "blobsha1" } }),
    },
    {
      match: (url: string, method: string) =>
        method === "GET" &&
        url === `${ORIGIN}/repos/${headRepo}/git/commits/${BASE_SHA}`,
      respond: () => ({
        status: 200,
        body: { sha: BASE_SHA, tree: { sha: "basetreesha" } },
      }),
    },
    {
      match: (url: string, method: string) =>
        method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/trees`,
      respond: () => ({ status: 201, body: { sha: "newtreesha" } }),
    },
    {
      match: (url: string, method: string) =>
        method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/commits`,
      respond: () => ({ status: 201, body: { sha: "newcommitsha" } }),
    },
    {
      match: (url: string, method: string) =>
        method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/refs`,
      respond: () => ({ status: 201, body: { ref: `refs/heads/${branch}` } }),
    },
    {
      match: (url: string, method: string) =>
        method === "PATCH" &&
        url === `${ORIGIN}/repos/${headRepo}/git/refs/heads/${branch}`,
      respond: () => ({ status: 200, body: { ref: `refs/heads/${branch}` } }),
    },
    {
      match: (url: string, method: string) =>
        method === "GET" &&
        url.startsWith(`${ORIGIN}/repos/${repo}/pulls?head=`),
      respond: () => ({ status: 200, body: existingPr ? [existingPr] : [] }),
    },
    {
      match: (url: string, method: string) =>
        method === "POST" && url === `${ORIGIN}/repos/${repo}/pulls`,
      respond: () => ({
        status: 201,
        body: { number: 42, html_url: `https://github.com/${repo}/pull/42` },
      }),
    },
    {
      match: (url: string, method: string) =>
        method === "PATCH" &&
        url === `${ORIGIN}/repos/${repo}/pulls/${existingPr?.number}`,
      respond: () => ({
        status: 200,
        body: {
          number: existingPr?.number,
          html_url: `https://github.com/${repo}/pull/${existingPr?.number}`,
        },
      }),
    },
    {
      match: (url: string, method: string) =>
        method === "GET" && url === `${ORIGIN}/user`,
      respond: () => ({ status: 200, body: { login: "worker-pat-bot" } }),
    },
  ];
}

describe("openPR — write path", () => {
  it("performs the exact REST sequence: blobs, tree with base_tree, commit with parents, ref create, PR create", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub(
      happyPathRoutes({
        headRepo: config.headRepo,
        repo: config.repo,
        branch: "fix/foo",
        base: config.base,
      })
    );

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const result = await gateway.openPR({
      branch: "fix/foo",
      title: "Fix the thing",
      commitMessage: "fix: the thing",
      body: "rendered body",
      diffRef,
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({
      number: 42,
      url: `https://github.com/${config.repo}/pull/42`,
      headRef: "fix/foo",
      author: "worker-pat-bot",
      updated: false,
    });

    // Every request carries the required headers.
    for (const call of calls) {
      expect(call.headers["user-agent"]).toBe("firefighter-worker");
      expect(call.headers["accept"]).toBe("application/vnd.github+json");
      expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }

    // The read that decides file CONTENT must be pinned to the exact commit
    // the diff assumes -- dropping `?ref=` silently reads the head repo's
    // default branch instead of `baseSha`, producing a wrong commit with
    // every other assertion in this test still green.
    const contentsCall = calls.find(
      (c) => c.method === "GET" && c.url.includes("/contents/")
    );
    expect(contentsCall?.url).toContain(`?ref=${BASE_SHA}`);

    const blobCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/blobs")
    );
    expect(blobCall?.body).toEqual({
      content: "line one\nline two, fixed\nline three\n",
      encoding: "utf-8",
    });

    const treeCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/trees")
    );
    expect(treeCall?.body).toEqual({
      base_tree: "basetreesha",
      tree: [
        { path: "src/app.ts", mode: "100644", type: "blob", sha: "blobsha1" },
      ],
    });

    const commitCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/commits")
    );
    expect(commitCall?.body).toEqual({
      message: "fix: the thing",
      tree: "newtreesha",
      parents: [BASE_SHA],
    });

    const refCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/refs")
    );
    expect(refCall?.body).toEqual({
      ref: "refs/heads/fix/foo",
      sha: "newcommitsha",
    });

    const prCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/pulls")
    );
    expect(prCall?.body).toEqual({
      title: "Fix the thing",
      body: "rendered body",
      head: `Zellify:fix/foo`,
      base: "staging",
    });
  });

  it("force-PATCHes the ref when POST refs 422s (already exists)", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    // Override the ref-create route to 422.
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.headRepo}/git/refs`, "POST")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/refs`,
        respond: () => ({
          status: 422,
          body: { message: "Reference already exists" },
        }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const result = await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "key-1",
    });

    const patchRefCall = calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/git/refs/heads/fix/foo")
    );
    expect(patchRefCall?.body).toEqual({ sha: "newcommitsha", force: true });
    // `updated` is documented as "an existing branch/PR was updated rather
    // than created". The branch existed and was force-updated here, so
    // reporting `false` because the PR itself is new tells a human the wrong
    // thing about the field they actually read.
    expect(result.updated).toBe(true);
  });

  it("PATCHes an existing open PR instead of creating a new one (updated: true)", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub(
      happyPathRoutes({
        headRepo: config.headRepo,
        repo: config.repo,
        branch: "fix/foo",
        base: config.base,
        existingPr: {
          number: 7,
          html_url: `https://github.com/${config.repo}/pull/7`,
        },
      })
    );

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const result = await gateway.openPR({
      branch: "fix/foo",
      title: "t2",
      commitMessage: "m",
      body: "b2",
      diffRef,
      idempotencyKey: "key-1",
    });

    expect(result.updated).toBe(true);
    expect(result.number).toBe(7);
    const patchCall = calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/pulls/7")
    );
    expect(patchCall?.body).toEqual({ title: "t2", body: "b2" });
    const postCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/pulls")
    );
    expect(postCall).toBeUndefined();
  });

  it("fork case: ref writes go to headRepo, PR writes go to repo, with a qualified head", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig({
      repo: "Zellify/web2app-rebuild",
      headRepo: "octo-fork/web2app-rebuild",
    });
    stubGithub(
      happyPathRoutes({
        headRepo: config.headRepo,
        repo: config.repo,
        branch: "fix/foo",
        base: config.base,
      })
    );

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "key-1",
    });

    // Ref/tree/commit/blob writes hit headRepo.
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url === `${ORIGIN}/repos/${config.headRepo}/git/blobs`
      )
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url === `${ORIGIN}/repos/${config.headRepo}/git/refs`
      )
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url === `${ORIGIN}/repos/${config.repo}/git/refs`
      )
    ).toBe(false);

    // PR list/create hit repo, with the head qualified by headRepo's owner.
    const prCall = calls.find(
      (c) =>
        c.method === "POST" && c.url === `${ORIGIN}/repos/${config.repo}/pulls`
    );
    expect(prCall?.body).toMatchObject({
      head: "octo-fork:fix/foo",
      base: "staging",
    });
    const listCall = calls.find(
      (c) =>
        c.method === "GET" &&
        c.url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`)
    );
    expect(listCall?.url).toContain(encodeURIComponent("octo-fork:fix/foo"));
  });

  it("null diffRef -> invalid_input naming the unknown/expired diffRef", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef: "diff_" + "0".repeat(64),
        idempotencyKey: "key-1",
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("unknown or expired diffRef"),
    });
    expect(calls.length).toBe(0);
  });

  it("propagates the applier's staleness refusal untouched when the base file has moved", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        // Content that no longer matches the diff's context lines.
        respond: () => ({
          status: 200,
          body: {
            content: contentOf("totally different content\n"),
            encoding: "base64",
          },
        }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "key-1",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps a 401 to capability_unavailable, nothing opened", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({ status: 401, body: { message: "Bad credentials" } }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("maps a 5xx to upstream_unavailable (in-doubt)", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({ status: 502, body: { message: "bad gateway" } }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("maps a 422 to invalid_input, carrying GitHub's message trimmed and dev-env-redacted", async () => {
    const testEnv = {
      ...testEnvWithPat(),
      MONOREPO_DEV_ENV: JSON.stringify({
        SECRET_TOKEN: "sVerySecretDevValue1234567890",
      }),
    } as unknown as Env;
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.headRepo}/git/commits`, "POST")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/commits`,
        respond: () => ({
          status: 422,
          body: {
            message:
              "Validation failed: bad value sVerySecretDevValue1234567890 present",
          },
        }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
    });

    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("sVerySecretDevValue1234567890");
      expect(message).toContain("redacted");
    }
  });

  /* ---------------------------------------- Critical 1: branch/path traversal -- */

  it("refuses a branch name containing .. before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "x/../../../../../../evil/repo/git/refs/heads/main",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef: "diff_" + "0".repeat(64),
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(0);
  });

  it("refuses a branch name containing a query-string character before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo?evil=1",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef: "diff_" + "0".repeat(64),
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(0);
  });

  it("refuses a branch name with a leading slash before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "/fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef: "diff_" + "0".repeat(64),
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(0);
  });

  it("refuses a diff path containing .. before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv, TRAVERSAL_PATCH, BASE_SHA);
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(0);
  });

  /* --------------------------------------------- Important 2: tree entries -- */

  it("posts a tree with an explicit null sha for a delete and preserves the applier's 100755 mode for a create", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv, MULTI_CHANGE_PATCH, BASE_SHA);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/src/old.ts`),
        respond: () => ({
          status: 200,
          body: {
            content: contentOf("line one\nline two\nline three\n"),
            encoding: "base64",
          },
        }),
      },
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/blobs`,
        respond: () => ({ status: 201, body: { sha: "blobsha-script" } }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/commits/${BASE_SHA}`,
        respond: () => ({
          status: 200,
          body: { sha: BASE_SHA, tree: { sha: "basetreesha" } },
        }),
      },
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/trees`,
        respond: () => ({ status: 201, body: { sha: "newtreesha" } }),
      },
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/commits`,
        respond: () => ({ status: 201, body: { sha: "newcommitsha" } }),
      },
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/refs`,
        respond: () => ({ status: 201, body: { ref: "refs/heads/fix/multi" } }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`),
        respond: () => ({ status: 200, body: [] }),
      },
      {
        match: (url: string, method: string) =>
          method === "POST" && url === `${ORIGIN}/repos/${config.repo}/pulls`,
        respond: () => ({
          status: 201,
          body: {
            number: 99,
            html_url: `https://github.com/${config.repo}/pull/99`,
          },
        }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" && url === `${ORIGIN}/user`,
        respond: () => ({ status: 200, body: { login: "worker-pat-bot" } }),
      },
    ]);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await gateway.openPR({
      branch: "fix/multi",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "k",
    });

    const treeCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/trees")
    );
    const treeBody = treeCall?.body as {
      base_tree: string;
      tree: Array<Record<string, unknown>>;
    };
    expect(treeBody.base_tree).toBe("basetreesha");
    expect(treeBody.tree).toHaveLength(2);

    const deleteEntry = treeBody.tree.find((e) => e.path === "src/old.ts");
    // Narrowed before the own-key check below: `Object.hasOwn` takes a
    // non-optional object, unlike the `Object.prototype.hasOwnProperty.call`
    // form this replaced, whose `.call` signature swallowed the `undefined`
    // that `.find()` can return.
    expect(deleteEntry).toBeDefined();
    if (deleteEntry === undefined) throw new Error("unreachable");
    expect(deleteEntry).toMatchObject({
      path: "src/old.ts",
      mode: "100644",
      type: "blob",
    });
    // The dangerous regression: JSON.stringify DROPS an `undefined` key, so a
    // `blobShas.get()` miss would serialize identically to an omitted `sha`
    // -- which GitHub treats as "leave the file alone", not "delete it".
    // `toEqual` cannot tell those apart; `hasOwnProperty` on the PARSED wire
    // body can.
    expect(Object.hasOwn(deleteEntry, "sha")).toBe(true);
    expect(deleteEntry?.sha).toBeNull();

    const createEntry = treeBody.tree.find((e) => e.path === "scripts/run.sh");
    expect(createEntry).toEqual({
      path: "scripts/run.sh",
      mode: "100755",
      type: "blob",
      sha: "blobsha-script",
    });
  });

  /* ------------------------------------------ Important 3: 404-on-contents -- */

  it("omits a 404 base file and lets the applier produce the staleness refusal, inventing no second message", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({ status: 404, body: { message: "Not Found" } }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining(
        "modifies a file the fetched base tree does not have"
      ),
    });
  });

  /* -------------------------------- Important 4: post-write failure wording -- */

  it("does not claim nothing was opened when the PR-ensure step fails after a successful ref push", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.repo}/pulls`, "POST")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "POST" && url === `${ORIGIN}/repos/${config.repo}/pulls`,
        respond: () => ({ status: 404, body: { message: "Not Found" } }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      // NOT `capability_unavailable`: that code is in `PROVEN_PRE_UPSTREAM`
      // (`src/codemode/effects.ts`), the set whose documented meaning is "the
      // call was refused BEFORE anything left this Worker". Recording a
      // commit that is sitting on the company repo as `failed` tells a human
      // reading the ledger the opposite of what happened, and tells a retry
      // that pushing again is safe. `upstream_unavailable` is outside that
      // set, so the row becomes `in_doubt` and `findPR` reconciles it.
      expect((err as { code?: string }).code).toBe("upstream_unavailable");
      const message = (err as Error).message;
      expect(message).not.toContain("nothing was opened");
      expect(message).toContain("fix/foo");
      expect(message.toLowerCase()).toContain("pushed");
    }

    // Meaningful only if the branch really was pushed before the PR step failed.
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          c.url === `${ORIGIN}/repos/${config.headRepo}/git/refs`
      )
    ).toBe(true);
  });

  it("classifies a 422 on the PR step after a successful ref push as in-doubt, keeping GitHub's message", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.repo}/pulls`, "POST")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "POST" && url === `${ORIGIN}/repos/${config.repo}/pulls`,
        respond: () => ({
          status: 422,
          body: { message: "No commits between staging and fix/foo" },
        }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      // `invalid_input` is also in PROVEN_PRE_UPSTREAM — same lie, different
      // code. The improved message survives the reclassification.
      expect((err as { code?: string }).code).toBe("upstream_unavailable");
      const message = (err as Error).message;
      expect(message).toContain("findPR");
      expect(message).toContain("No commits between");
    }
  });

  it("still says nothing was opened when the failure happens BEFORE any ref write", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.headRepo}/git/refs`, "POST")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "POST" &&
          url === `${ORIGIN}/repos/${config.headRepo}/git/refs`,
        respond: () => ({
          status: 403,
          body: { message: "Resource not accessible" },
        }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("nothing was opened"),
    });
  });
});

/* ------------------------------- Final review: seam findings 1, 3, 4 and 5 -- */

/**
 * REAL non-UTF-8 BYTES, not a mock that claims to be one.
 *
 * Captured from a real repository: `latin.txt` holds
 * `line one\ncaf<0xE9> latin\nline three\n` — latin-1, no NUL anywhere, so git
 * diffs it as TEXT and every binary refusal in the applier passes it through.
 * The base64 below is that file's exact bytes, so the decode under test is the
 * real one on real invalid UTF-8.
 *
 * The patch is what actually reaches the Worker: git wrote the raw 0xE9 to
 * stdout, the container's stdout is read as UTF-8, and the byte became U+FFFD
 * on the way in. That is precisely why the applier's byte-exact context check
 * cannot catch this — the fetched base, decoded the same lossy way, agrees
 * with the mangled patch, and the U+FFFD would be committed over a line the
 * fix never touched.
 */
const LATIN1_BASE_B64 = "bGluZSBvbmUKY2Fm6SBsYXRpbgpsaW5lIHRocmVlCg==";
const LATIN1_PATCH = `diff --git a/latin.txt b/latin.txt
index 9059c04..0530b44 100644
--- a/latin.txt
+++ b/latin.txt
@@ -1,3 +1,3 @@
-line one
+line one changed
 caf� latin
 line three
`;

/** The control: the same file, really UTF-8. Multibyte content must still ship. */
const UTF8_BASE_B64 = "bGluZSBvbmUKY2Fmw6kgbGF0aW4KbGluZSB0aHJlZQo=";
const UTF8_PATCH = `diff --git a/utf8.txt b/utf8.txt
index e418bed..2623764 100644
--- a/utf8.txt
+++ b/utf8.txt
@@ -1,3 +1,3 @@
-line one
+line one changed
 café latin
 line three
`;

describe("openPR — base content fidelity (finding 1)", () => {
  it("refuses a base file that is not valid UTF-8, by name, instead of committing U+FFFD over untouched lines", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv, LATIN1_PATCH, BASE_SHA);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({
          status: 200,
          body: { content: LATIN1_BASE_B64, encoding: "base64" },
        }),
      },
    ]);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("latin.txt"),
    });

    // Refused, per invariant 6 — and refused before anything was written.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says the file is not valid UTF-8 rather than that the diff is stale", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv, LATIN1_PATCH, BASE_SHA);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({
          status: 200,
          body: { content: LATIN1_BASE_B64, encoding: "base64" },
        }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("UTF-8");
      expect(message.toLowerCase()).not.toContain("re-run diff");
    }
  });

  it("still ships a base file whose multibyte UTF-8 round-trips, byte-exact", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv, UTF8_PATCH, BASE_SHA);
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(
      routes.findIndex((r) =>
        r.match(`${ORIGIN}/repos/${config.headRepo}/contents/utf8.txt`, "GET")
      ),
      1,
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({
          status: 200,
          body: { content: UTF8_BASE_B64, encoding: "base64" },
        }),
      }
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "k",
    });

    const blobCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/git/blobs")
    );
    expect(blobCall?.body).toEqual({
      content: "line one changed\ncafé latin\nline three\n",
      encoding: "utf-8",
    });
  });

  it('refuses a file GitHub will not base64 (over 1 MB, encoding "none") by name, not as a stale diff', async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      compareRoute(config.repo),
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.includes(`/repos/${config.headRepo}/contents/`),
        // Exactly what the contents API answers for a 1–100 MB file.
        respond: () => ({
          status: 200,
          body: { content: "", encoding: "none", size: 4_000_000 },
        }),
      },
    ]);

    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_input");
      const message = (err as Error).message;
      expect(message).toContain("src/app.ts");
      expect(message).toContain("1 MB");
      // The road with no end: "re-run diff" cannot help a file that is merely
      // too big, and the model would keep walking it.
      expect(message.toLowerCase()).not.toContain("re-run diff");
    }
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("openPR — base sha validation (finding 3)", () => {
  it("refuses a base sha that is not 40 lowercase hex, before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(
      testEnv,
      SIMPLE_PATCH,
      "abc123../../../../repos/other/private/git/commits/deadbeef"
    );
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(0);
  });

  it("refuses a shortened sha and an uppercase one, before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );

    for (const sha of ["abc123d", BASE_SHA.toUpperCase()]) {
      const diffRef = await seedDiff(testEnv, SIMPLE_PATCH, sha);
      await expect(
        gateway.openPR({
          branch: "fix/foo",
          title: "t",
          commitMessage: "m",
          body: "b",
          diffRef,
          idempotencyKey: "k",
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(calls.length).toBe(0);
  });
});

describe("openPR — base branch containment (finding 4)", () => {
  function stubCompare(status: string): GithubShipConfig {
    const config = baseConfig();
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(0, 1, compareRoute(config.repo, status));
    stubGithub(routes);
    return config;
  }

  it("compares the configured base against the diff's base commit before anything is written", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = stubCompare("behind");
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "k",
    });

    const compareCall = calls.find((c) => c.url.includes("/compare/"));
    expect(compareCall?.method).toBe("GET");
    expect(compareCall?.url).toBe(
      `${ORIGIN}/repos/${config.repo}/compare/staging...${BASE_SHA}`
    );
    // It is the FIRST request: nothing is fetched or written before the
    // containment question is answered.
    expect(calls[0]?.url).toContain("/compare/");
  });

  it("accepts an identical base (the sandbox is exactly at the base branch tip)", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = stubCompare("identical");
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const result = await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "k",
    });
    expect(result.number).toBe(42);
  });

  it("refuses when the working tree was cut from a commit AHEAD of the base branch — the direction that lands a planted bug on staging", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = stubCompare("ahead");
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    try {
      await gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_input");
      const message = (err as Error).message;
      // Both refs named: neither one alone tells a human what to change.
      expect(message).toContain("staging");
      expect(message).toContain(BASE_SHA);
    }
    // The whole point: no blob, no tree, no commit, no ref, no PR.
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("refuses a diverged base too", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = stubCompare("diverged");
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "k",
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls.length).toBe(1);
  });

  it("passes for the drill's deliberate override: sandbox and GITHUB_BASE both on the planted branch", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig({ base: "drill/planted-bug" });
    const routes = happyPathRoutes({
      headRepo: config.headRepo,
      repo: config.repo,
      branch: "fix/foo",
      base: config.base,
    });
    routes.splice(0, 1, compareRoute(config.repo, "identical"));
    stubGithub(routes);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "k",
    });
    const compareCall = calls.find((c) => c.url.includes("/compare/"));
    expect(compareCall?.url).toBe(
      `${ORIGIN}/repos/${config.repo}/compare/drill/planted-bug...${BASE_SHA}`
    );
  });
});

/* ------------------------------------------------------------ Step 3: reads -- */

describe("findPR", () => {
  it("maps the head-filtered list to a PullRequestRef", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`),
        respond: () => ({
          status: 200,
          body: [
            { number: 9, html_url: `https://github.com/${config.repo}/pull/9` },
          ],
        }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" && url === `${ORIGIN}/user`,
        respond: () => ({ status: 200, body: { login: "worker-pat-bot" } }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const result = await gateway.findPR("fix/foo");
    expect(result).toEqual({
      number: 9,
      url: `https://github.com/${config.repo}/pull/9`,
      headRef: "fix/foo",
      author: "worker-pat-bot",
      updated: true,
    });
  });

  it("returns null when there is no open PR for the branch", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`),
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    expect(await gateway.findPR("fix/foo")).toBeNull();
  });
});

describe("checkPR", () => {
  function stubCheck(prBody: unknown, comments: unknown) {
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url === `${ORIGIN}/repos/Zellify/web2app-rebuild/pulls/42`,
        respond: () => ({ status: 200, body: prBody }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" &&
          url.startsWith(
            `${ORIGIN}/repos/Zellify/web2app-rebuild/issues/42/comments`
          ),
        respond: () => ({ status: 200, body: comments }),
      },
    ]);
  }

  const openPr = {
    state: "open",
    merged: false,
    html_url: "https://github.com/Zellify/web2app-rebuild/pull/42",
    head: { ref: "fix/foo" },
    base: { ref: "staging" },
  };

  it("recognises the linear-code bot linkback, tolerant of [bot] suffixing, and extracts identifiers", async () => {
    stubCheck(openPr, [
      { user: { login: "someone-else" }, body: "not it" },
      {
        user: { login: "linear-code[bot]" },
        body: "Linked to FIR-123 and also FIR-456.",
      },
    ]);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const status = await gateway.checkPR(42);
    expect(status).toEqual({
      state: "open",
      url: openPr.html_url,
      headRef: "fix/foo",
      baseRef: "staging",
      linearLinkback: { commented: true, identifiers: ["FIR-123", "FIR-456"] },
    });
  });

  it("reports commented: false, identifiers: [] when there is no linkback comment (a fact, not an error)", async () => {
    stubCheck(openPr, [
      { user: { login: "someone-else" }, body: "irrelevant" },
    ]);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const status = await gateway.checkPR(42);
    expect(status.linearLinkback).toEqual({
      commented: false,
      identifiers: [],
    });
  });

  it("reports merged state distinct from open/closed", async () => {
    stubCheck({ ...openPr, state: "closed", merged: true }, []);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const status = await gateway.checkPR(42);
    expect(status.state).toBe("merged");
  });

  it("paginates the linkback comment read past the first page via Link: rel=next", async () => {
    const config = baseConfig();
    const commentsBase = `${ORIGIN}/repos/${config.repo}/issues/42/comments`;
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" && url === `${ORIGIN}/repos/${config.repo}/pulls/42`,
        respond: () => ({ status: 200, body: openPr }),
      },
      {
        // The FIRST page: no linkback yet, and a Link header pointing at page 2.
        match: (url: string, method: string) =>
          method === "GET" &&
          url.startsWith(commentsBase) &&
          !url.includes("page=2"),
        respond: () => ({
          status: 200,
          body: [{ user: { login: "someone-else" }, body: "page one, not it" }],
          headers: {
            Link: `<${commentsBase}?per_page=100&page=2>; rel="next"`,
          },
        }),
      },
      {
        // The SECOND page: where the linkback actually lives -- a gateway
        // that only reads page one reports `commented: false` here, which
        // is a false negative the model would act on.
        match: (url: string, method: string) =>
          method === "GET" && url.includes("page=2"),
        respond: () => ({
          status: 200,
          body: [
            { user: { login: "linear-code[bot]" }, body: "Linked FIR-999." },
          ],
        }),
      },
    ]);
    const testEnv = testEnvWithPat();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const status = await gateway.checkPR(42);
    expect(status.linearLinkback).toEqual({
      commented: true,
      identifiers: ["FIR-999"],
    });
  });

  it("refuses a traversal-shaped pull request number before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    // `number` is erased at runtime -- the codemode boundary can hand this
    // whatever JSON carries, so the attack is exercised past the type system
    // with an explicit cast, the same way a real malicious call would arrive.
    const traversal =
      "42/../../../../repos/other/private/pulls/1" as unknown as number;
    await expect(gateway.checkPR(traversal)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(calls.length).toBe(0);
  });

  it("refuses a non-integer pull request number before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(gateway.checkPR(1.5)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(calls.length).toBe(0);
  });

  it("refuses a non-positive pull request number before any request is made", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    await expect(gateway.checkPR(0)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(gateway.checkPR(-42)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(calls.length).toBe(0);
  });

  it("stops paginating rather than follow a Link header off GITHUB_ORIGIN", async () => {
    const config = baseConfig();
    const commentsBase = `${ORIGIN}/repos/${config.repo}/issues/42/comments`;
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" && url === `${ORIGIN}/repos/${config.repo}/pulls/42`,
        respond: () => ({ status: 200, body: openPr }),
      },
      {
        match: (url: string, method: string) =>
          method === "GET" && url.startsWith(commentsBase),
        respond: () => ({
          status: 200,
          body: [{ user: { login: "someone-else" }, body: "page one" }],
          // A response-supplied Link pointing OFF the pinned origin -- must
          // not be followed with a credentialed request.
          headers: {
            Link: `<https://evil.example.com/steal?token=1>; rel="next"`,
          },
        }),
      },
    ]);
    const testEnv = testEnvWithPat();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );
    const status = await gateway.checkPR(42);
    expect(status.linearLinkback).toEqual({
      commented: false,
      identifiers: [],
    });
    expect(calls.every((c) => c.url.startsWith(ORIGIN))).toBe(true);
  });
});

describe("searchPRs", () => {
  const items = [
    {
      number: 1534,
      title: "fix: remove Pricing link from landing navbar",
      state: "open",
      html_url: "https://github.com/Zellify/web2app-rebuild/pull/1534",
      updated_at: "2026-08-16T20:33:39Z",
      user: { login: "sayandedotcom" },
      pull_request: { merged_at: null },
    },
    {
      number: 772,
      title: "landing: nav restructure",
      state: "closed",
      html_url: "https://github.com/Zellify/web2app-rebuild/pull/772",
      updated_at: "2026-04-28T10:43:13Z",
      user: { login: "NilsNygren" },
      // The search shape says `closed` for a merged PR; `merged_at` is the tell.
      pull_request: { merged_at: "2026-04-28T10:40:42Z" },
    },
  ];

  it("pins the repo server-side, keeps a model-supplied qualifier from widening it, and reads merged from merged_at", async () => {
    stubGithub([
      {
        match: (url: string, method: string) =>
          method === "GET" && url.startsWith(`${ORIGIN}/search/issues?`),
        respond: () => ({
          status: 200,
          body: { total_count: 2, incomplete_results: false, items },
        }),
      },
    ]);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(
      testEnv,
      config,
      makeGithubAuthSource(testEnv, config),
      () => NOW
    );

    // The model's text carries its own `repo:` — it must be ADDED to ours,
    // never replace it, so GitHub ANDs both and the pinned one still holds.
    const found = await gateway.searchPRs("pricing navbar repo:evil/other", 5);

    expect(found).toEqual([
      {
        number: 1534,
        title: "fix: remove Pricing link from landing navbar",
        state: "open",
        url: "https://github.com/Zellify/web2app-rebuild/pull/1534",
        author: "sayandedotcom",
        updatedAt: "2026-08-16T20:33:39Z",
      },
      {
        number: 772,
        title: "landing: nav restructure",
        state: "merged",
        url: "https://github.com/Zellify/web2app-rebuild/pull/772",
        author: "NilsNygren",
        updatedAt: "2026-04-28T10:43:13Z",
      },
    ]);

    expect(calls.length).toBe(1);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("q")).toBe(
      "is:pr repo:Zellify/web2app-rebuild pricing navbar repo:evil/other"
    );
    expect(q.get("per_page")).toBe("5");
    expect(q.get("advanced_search")).toBe("true");
    expect(calls[0].url.startsWith(ORIGIN)).toBe(true);
  });
});
