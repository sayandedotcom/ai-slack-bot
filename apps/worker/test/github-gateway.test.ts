import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { captureDiff } from "../src/sandbox/diff";
import { importIdentityKey, seal } from "../src/identity/crypto";
import { upsertIdentity } from "../src/db/identities";
import {
  makeGithubAuthSource,
  makeGithubGateway,
  resolveGithubConfig,
  type GithubShipConfig,
} from "../src/git/commit";
import { MONOREPO_SLUG } from "../src/sandbox/class";

const worker = env as unknown as Env;

const IDENTITY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)));
const NOW = Date.parse("2026-08-15T00:00:00Z");
// Two shifts before NOW so the trial-tester override at ROTATION[0] is not
// who's on duty; keeps these cases independent of the roster's index-0 quirk.
const ON_DUTY_INSTANT = NOW;

const ORIGIN = "https://api.github.com";

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
let calls: Call[] = [];

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new Headers(init?.headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

type Route = { match: (url: string, method: string) => boolean; respond: (url: string, body: unknown) => { status: number; body: unknown } };

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
    const { status, body: respBody } = route.respond(target, body);
    return new Response(JSON.stringify(respBody), { status });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseConfig(overrides: Partial<GithubShipConfig> = {}): GithubShipConfig {
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
    const testEnv = { ...worker, MONOREPO_PAT: "ghp_worker_pat_token" } as unknown as Env;
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

  it("on-duty resolves the shift engineer's decrypted github identity", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const key = await importIdentityKey(IDENTITY_KEY);
    // Whoever is on duty at ON_DUTY_INSTANT -- read it back via the same
    // `onDuty` the source uses, so this case does not hardcode the roster.
    const { onDuty } = await import("../src/identity/rotation");
    const { email } = onDuty(ON_DUTY_INSTANT);

    await upsertIdentity(
      testEnv.DB,
      {
        email,
        provider: "github",
        externalId: "octo-shift",
        scopes: "repo",
        tokenCiphertext: await seal(key, "gho_on_duty_token"),
        connectedAt: NOW,
      },
      NOW,
    );

    const config = baseConfig({ author: "on-duty" });
    const auth = makeGithubAuthSource(testEnv, config);
    expect(await auth.token(ON_DUTY_INSTANT)).toEqual({ token: "gho_on_duty_token" });
  });

  it("on-duty resolves null when the shift engineer has not connected github", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const config = baseConfig({ author: "on-duty" });
    const auth = makeGithubAuthSource(testEnv, config);
    // Use a far-future instant so no earlier test's upsert can leak in.
    expect(await auth.token(Date.parse("2027-01-01T00:00:00Z"))).toBeNull();
  });

  it("a null auth source produces capability_unavailable naming the fix (worker-pat)", async () => {
    const testEnv = { ...worker, MONOREPO_PAT: undefined } as unknown as Env;
    const config = baseConfig({ author: "worker-pat" });
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(gateway.findPR("some-branch")).rejects.toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("set MONOREPO_PAT"),
    });
  });

  it("a null auth source produces capability_unavailable naming the fix (on-duty)", async () => {
    const testEnv = { ...worker, IDENTITY_KEY } as unknown as Env;
    const config = baseConfig({ author: "on-duty" });
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => Date.parse("2027-02-01T00:00:00Z"));
    await expect(gateway.findPR("some-branch")).rejects.toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("connect GitHub on the dashboard"),
    });
  });

  it("refuses a configured base of dev, by name, at construction", () => {
    const testEnv = { ...worker, MONOREPO_PAT: "x" } as unknown as Env;
    const config = baseConfig({ base: "dev" });
    expect(() => makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW)).toThrow(/dev/);
  });

  it("defaults the repo slug to MONOREPO_SLUG when GITHUB_REPO is absent", () => {
    const testEnv = { ...worker, GITHUB_REPO: undefined, GITHUB_HEAD_REPO: undefined, GITHUB_BASE: undefined, GITHUB_AUTHOR: undefined } as unknown as Env;
    const config = resolveGithubConfig(testEnv);
    expect(config.repo).toBe(MONOREPO_SLUG);
    expect(config.headRepo).toBe(MONOREPO_SLUG);
    expect(config.base).toBe("staging");
    expect(config.author).toBe("worker-pat");
  });
});

/* ----------------------------------------------------- Step 2: write path -- */

const BASE_SHA = "abc123def456abc123def456abc123def456abc";
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

function testEnvWithPat(overrides: Record<string, unknown> = {}): Env {
  return { ...worker, MONOREPO_PAT: TOKEN, ...overrides } as unknown as Env;
}

async function seedDiff(testEnv: Env, patch = SIMPLE_PATCH, baseSha = BASE_SHA): Promise<string> {
  const result = await captureDiff(testEnv, `run_${crypto.randomUUID()}`, patch, baseSha);
  if (result.diffRef === null) throw new Error("expected a diffRef");
  return result.diffRef;
}

function contentOf(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
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
      match: (url: string, method: string) => method === "GET" && url.includes(`/repos/${headRepo}/contents/`),
      respond: () => ({ status: 200, body: { content: contentOf("line one\nline two\nline three\n"), encoding: "base64" } }),
    },
    {
      match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/blobs`,
      respond: () => ({ status: 201, body: { sha: "blobsha1" } }),
    },
    {
      match: (url: string, method: string) => method === "GET" && url === `${ORIGIN}/repos/${headRepo}/git/commits/${BASE_SHA}`,
      respond: () => ({ status: 200, body: { sha: BASE_SHA, tree: { sha: "basetreesha" } } }),
    },
    {
      match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/trees`,
      respond: () => ({ status: 201, body: { sha: "newtreesha" } }),
    },
    {
      match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/commits`,
      respond: () => ({ status: 201, body: { sha: "newcommitsha" } }),
    },
    {
      match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${headRepo}/git/refs`,
      respond: () => ({ status: 201, body: { ref: `refs/heads/${branch}` } }),
    },
    {
      match: (url: string, method: string) => method === "PATCH" && url === `${ORIGIN}/repos/${headRepo}/git/refs/heads/${branch}`,
      respond: () => ({ status: 200, body: { ref: `refs/heads/${branch}` } }),
    },
    {
      match: (url: string, method: string) => method === "GET" && url.startsWith(`${ORIGIN}/repos/${repo}/pulls?head=`),
      respond: () => ({ status: 200, body: existingPr ? [existingPr] : [] }),
    },
    {
      match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${repo}/pulls`,
      respond: () => ({ status: 201, body: { number: 42, html_url: `https://github.com/${repo}/pull/42` } }),
    },
    {
      match: (url: string, method: string) => method === "PATCH" && url === `${ORIGIN}/repos/${repo}/pulls/${existingPr?.number}`,
      respond: () => ({ status: 200, body: { number: existingPr?.number, html_url: `https://github.com/${repo}/pull/${existingPr?.number}` } }),
    },
    {
      match: (url: string, method: string) => method === "GET" && url === `${ORIGIN}/user`,
      respond: () => ({ status: 200, body: { login: "worker-pat-bot" } }),
    },
  ];
}

describe("openPR — write path", () => {
  it("performs the exact REST sequence: blobs, tree with base_tree, commit with parents, ref create, PR create", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub(happyPathRoutes({ headRepo: config.headRepo, repo: config.repo, branch: "fix/foo", base: config.base }));

    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
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

    const blobCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/blobs"));
    expect(blobCall?.body).toEqual({ content: "line one\nline two, fixed\nline three\n", encoding: "utf-8" });

    const treeCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(treeCall?.body).toEqual({
      base_tree: "basetreesha",
      tree: [{ path: "src/app.ts", mode: "100644", type: "blob", sha: "blobsha1" }],
    });

    const commitCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
    expect(commitCall?.body).toEqual({ message: "fix: the thing", tree: "newtreesha", parents: [BASE_SHA] });

    const refCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"));
    expect(refCall?.body).toEqual({ ref: "refs/heads/fix/foo", sha: "newcommitsha" });

    const prCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"));
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
    const routes = happyPathRoutes({ headRepo: config.headRepo, repo: config.repo, branch: "fix/foo", base: config.base });
    // Override the ref-create route to 422.
    routes.splice(
      routes.findIndex((r) => r.match(`${ORIGIN}/repos/${config.headRepo}/git/refs`, "POST")),
      1,
      {
        match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${config.headRepo}/git/refs`,
        respond: () => ({ status: 422, body: { message: "Reference already exists" } }),
      },
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "key-1",
    });

    const patchRefCall = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/git/refs/heads/fix/foo"));
    expect(patchRefCall?.body).toEqual({ sha: "newcommitsha", force: true });
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
        existingPr: { number: 7, html_url: `https://github.com/${config.repo}/pull/7` },
      }),
    );

    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
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
    const patchCall = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/pulls/7"));
    expect(patchCall?.body).toEqual({ title: "t2", body: "b2" });
    const postCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"));
    expect(postCall).toBeUndefined();
  });

  it("fork case: ref writes go to headRepo, PR writes go to repo, with a qualified head", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig({ repo: "Zellify/web2app-rebuild", headRepo: "octo-fork/web2app-rebuild" });
    stubGithub(happyPathRoutes({ headRepo: config.headRepo, repo: config.repo, branch: "fix/foo", base: config.base }));

    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await gateway.openPR({
      branch: "fix/foo",
      title: "t",
      commitMessage: "m",
      body: "b",
      diffRef,
      idempotencyKey: "key-1",
    });

    // Ref/tree/commit/blob writes hit headRepo.
    expect(calls.some((c) => c.method === "POST" && c.url === `${ORIGIN}/repos/${config.headRepo}/git/blobs`)).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url === `${ORIGIN}/repos/${config.headRepo}/git/refs`)).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url === `${ORIGIN}/repos/${config.repo}/git/refs`)).toBe(false);

    // PR list/create hit repo, with the head qualified by headRepo's owner.
    const prCall = calls.find((c) => c.method === "POST" && c.url === `${ORIGIN}/repos/${config.repo}/pulls`);
    expect(prCall?.body).toMatchObject({ head: "octo-fork:fix/foo", base: "staging" });
    const listCall = calls.find((c) => c.method === "GET" && c.url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`));
    expect(listCall?.url).toContain(encodeURIComponent("octo-fork:fix/foo"));
  });

  it("null diffRef -> invalid_input naming the unknown/expired diffRef", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef: "diff_" + "0".repeat(64),
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("unknown or expired diffRef") });
    expect(calls.length).toBe(0);
  });

  it("propagates the applier's staleness refusal untouched when the base file has moved", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) => method === "GET" && url.includes(`/repos/${config.headRepo}/contents/`),
        // Content that no longer matches the diff's context lines.
        respond: () => ({ status: 200, body: { content: contentOf("totally different content\n"), encoding: "base64" } }),
      },
    ]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(
      gateway.openPR({
        branch: "fix/foo",
        title: "t",
        commitMessage: "m",
        body: "b",
        diffRef,
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps a 401 to capability_unavailable, nothing opened", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) => method === "GET" && url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({ status: 401, body: { message: "Bad credentials" } }),
      },
    ]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(
      gateway.openPR({ branch: "fix/foo", title: "t", commitMessage: "m", body: "b", diffRef, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });

  it("maps a 5xx to upstream_unavailable (in-doubt)", async () => {
    const testEnv = testEnvWithPat();
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) => method === "GET" && url.includes(`/repos/${config.headRepo}/contents/`),
        respond: () => ({ status: 502, body: { message: "bad gateway" } }),
      },
    ]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(
      gateway.openPR({ branch: "fix/foo", title: "t", commitMessage: "m", body: "b", diffRef, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("maps a 422 to invalid_input, carrying GitHub's message trimmed and dev-env-redacted", async () => {
    const testEnv = { ...testEnvWithPat(), MONOREPO_DEV_ENV: JSON.stringify({ SECRET_TOKEN: "sVerySecretDevValue1234567890" }) } as unknown as Env;
    const diffRef = await seedDiff(testEnv);
    const config = baseConfig();
    const routes = happyPathRoutes({ headRepo: config.headRepo, repo: config.repo, branch: "fix/foo", base: config.base });
    routes.splice(
      routes.findIndex((r) => r.match(`${ORIGIN}/repos/${config.headRepo}/git/commits`, "POST")),
      1,
      {
        match: (url: string, method: string) => method === "POST" && url === `${ORIGIN}/repos/${config.headRepo}/git/commits`,
        respond: () => ({
          status: 422,
          body: { message: "Validation failed: bad value sVerySecretDevValue1234567890 present" },
        }),
      },
    );
    stubGithub(routes);

    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    await expect(
      gateway.openPR({ branch: "fix/foo", title: "t", commitMessage: "m", body: "b", diffRef, idempotencyKey: "k" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });

    try {
      await gateway.openPR({ branch: "fix/foo", title: "t", commitMessage: "m", body: "b", diffRef, idempotencyKey: "k" });
      throw new Error("expected to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("sVerySecretDevValue1234567890");
      expect(message).toContain("redacted");
    }
  });
});

/* ------------------------------------------------------------ Step 3: reads -- */

describe("findPR", () => {
  it("maps the head-filtered list to a PullRequestRef", async () => {
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    stubGithub([
      {
        match: (url: string, method: string) => method === "GET" && url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`),
        respond: () => ({ status: 200, body: [{ number: 9, html_url: `https://github.com/${config.repo}/pull/9` }] }),
      },
      {
        match: (url: string, method: string) => method === "GET" && url === `${ORIGIN}/user`,
        respond: () => ({ status: 200, body: { login: "worker-pat-bot" } }),
      },
    ]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
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
        match: (url: string, method: string) => method === "GET" && url.startsWith(`${ORIGIN}/repos/${config.repo}/pulls?head=`),
        respond: () => ({ status: 200, body: [] }),
      },
    ]);
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    expect(await gateway.findPR("fix/foo")).toBeNull();
  });
});

describe("checkPR", () => {
  function stubCheck(prBody: unknown, comments: unknown) {
    stubGithub([
      {
        match: (url: string, method: string) => method === "GET" && url === `${ORIGIN}/repos/Zellify/web2app-rebuild/pulls/42`,
        respond: () => ({ status: 200, body: prBody }),
      },
      {
        match: (url: string, method: string) => method === "GET" && url === `${ORIGIN}/repos/Zellify/web2app-rebuild/issues/42/comments`,
        respond: () => ({ status: 200, body: comments }),
      },
    ]);
  }

  const openPr = { state: "open", merged: false, html_url: "https://github.com/Zellify/web2app-rebuild/pull/42", head: { ref: "fix/foo" }, base: { ref: "staging" } };

  it("recognises the linear-code bot linkback, tolerant of [bot] suffixing, and extracts identifiers", async () => {
    stubCheck(openPr, [
      { user: { login: "someone-else" }, body: "not it" },
      { user: { login: "linear-code[bot]" }, body: "Linked to FIR-123 and also FIR-456." },
    ]);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
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
    stubCheck(openPr, [{ user: { login: "someone-else" }, body: "irrelevant" }]);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    const status = await gateway.checkPR(42);
    expect(status.linearLinkback).toEqual({ commented: false, identifiers: [] });
  });

  it("reports merged state distinct from open/closed", async () => {
    stubCheck({ ...openPr, state: "closed", merged: true }, []);
    const testEnv = testEnvWithPat();
    const config = baseConfig();
    const gateway = makeGithubGateway(testEnv, config, makeGithubAuthSource(testEnv, config), () => NOW);
    const status = await gateway.checkPR(42);
    expect(status.state).toBe("merged");
  });
});
