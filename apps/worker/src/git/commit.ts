import type { Env } from "../index";
import { CapabilityError } from "../codemode/errors";
import type { GithubGateway, PullRequestRef, PullRequestStatus } from "../codemode/gateways";
import { applyUnifiedDiff, basePaths } from "./apply";
import { readDiffWithBase } from "../sandbox/diff";
import { devEnvFor } from "../sandbox/env";
import { makeRedactor } from "../sandbox/gateway";
import { MONOREPO_SLUG } from "../sandbox/class";
import { getIdentity } from "../db/identities";
import { getDecryptedToken } from "../identity/tokens";
import { onDuty } from "../identity/rotation";

/**
 * The last leg of the pipeline: a stored diff becomes a real commit on a real
 * pull request, on a private company monorepo, with no human in between.
 *
 * This module is TRANSPORT ONLY. It knows how to turn `FileChange[]` into
 * blobs, a tree, a commit, a ref and a PR — it has no opinion about what the
 * PR body says or what "Fixes FIR-123" means. That is a concurrent task's
 * wall; see `src/codemode/gateways.ts`'s `GithubGateway.openPR` for the
 * contract this file implements.
 *
 * Pinned in code, not configuration, same reasoning as `LINEAR_ORIGIN` in
 * `src/linear/client.ts`: an origin that can be supplied is an origin that
 * can be redirected, and this client carries a credential that can push to a
 * customer's monorepo.
 */
const GITHUB_ORIGIN = "https://api.github.com";

/** GitHub's REST API 403s a request with no `User-Agent`. Same constant as `src/oauth/github.ts`. */
const USER_AGENT = "firefighter-worker";

/**
 * The linear-code bot's GitHub login, tolerant of the `[bot]` suffix GitHub
 * appends to every App-authored comment (`linear-code[bot]`, not
 * `linear-code`) — verified against the pattern `src/oauth/github.ts` already
 * documents for GitHub's own quirks.
 */
const LINEAR_BOT_LOGIN = /^linear-code(\[bot\])?$/i;

/** `[A-Z]+-\d+` — Linear's issue identifier shape, e.g. `FIR-123`. */
const IDENTIFIER_PATTERN = /[A-Z]+-\d+/g;

/**
 * GitHub's 422 bodies quote back what was sent — same failure mode
 * `src/oauth/github.ts` avoids on its exchange leg. Bounding the echo even
 * after redaction keeps a very large payload from becoming a very large
 * model-facing string.
 */
const MAX_ERROR_MESSAGE_CHARS = 500;

export type GithubShipConfig = {
  /** GITHUB_REPO — "owner/name". The repo the PR opens ON. Default: MONOREPO_SLUG from src/sandbox/class.ts. */
  repo: string;
  /** GITHUB_HEAD_REPO — "owner/name". Where the head REF is pushed. Default: repo. */
  headRepo: string;
  /** GITHUB_BASE — the PR base ref. Default: "staging". Never "dev". */
  base: string;
  /** GITHUB_AUTHOR — whose token authors the commit and PR. */
  author: "on-duty" | "worker-pat";
};

export interface GithubAuthSource {
  /** The authoring token, or null when the configured identity has none. */
  token(nowMs: number): Promise<{ token: string } | null>;
}

/**
 * `env.GITHUB_REPO` / `GITHUB_HEAD_REPO` / `GITHUB_BASE` / `GITHUB_AUTHOR`,
 * defaulted per the pinned interface's own doc comments. Absence is a state
 * the code can see (same discipline as `devEnvFor`) — a deployment with no
 * `GITHUB_HEAD_REPO` set still opens PRs, just always against `repo` itself.
 */
export function resolveGithubConfig(env: Env): GithubShipConfig {
  const repo = env.GITHUB_REPO?.trim() || MONOREPO_SLUG;
  const headRepo = env.GITHUB_HEAD_REPO?.trim() || repo;
  const base = env.GITHUB_BASE?.trim() || "staging";
  const author = (env.GITHUB_AUTHOR?.trim() === "on-duty" ? "on-duty" : "worker-pat") as
    | "on-duty"
    | "worker-pat";
  return { repo, headRepo, base, author };
}

/**
 * The `on-duty` / `worker-pat` chain, mirroring `src/identity/user-token.ts`'s
 * rotation → identity row → decrypted token pattern exactly, narrowed to just
 * the token this gateway needs.
 *
 * `worker-pat` never touches D1 or the rotation — it is a single Worker
 * secret, present or not. `on-duty` never falls back to `worker-pat` on a
 * missing credential: a missing credential is an honest refusal, not a
 * silent switch to a different identity's authority.
 */
export function makeGithubAuthSource(env: Env, config: GithubShipConfig): GithubAuthSource {
  return {
    async token(nowMs: number): Promise<{ token: string } | null> {
      if (config.author === "worker-pat") {
        const pat = env.MONOREPO_PAT;
        return pat ? { token: pat } : null;
      }

      const { email } = onDuty(nowMs);
      const row = await getIdentity(env.DB, email, "github");
      if (!row) return null;

      const token = await getDecryptedToken(env, email, "github");
      return token ? { token } : null;
    },
  };
}

function githubHeaders(token: string, hasBody: boolean): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

/**
 * One request, one place credentials and the `User-Agent` quirk are spent.
 * A thrown network error becomes `upstream_unavailable` here rather than at
 * each call site — indistinguishable from a 5xx to the caller, which is
 * correct: neither proves the request was never processed.
 */
async function githubFetch(
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: githubHeaders(token, body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new CapabilityError(
      "upstream_unavailable",
      "GitHub could not be reached; whether anything was created is unknown.",
    );
  }
}

/** Best-effort extraction of GitHub's own error text, for the 422 case only. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    };
    const extra = (body.errors ?? [])
      .map((e) => e.message)
      .filter((m): m is string => typeof m === "string" && m.length > 0)
      .join("; ");
    return [body.message, extra].filter((s) => typeof s === "string" && s.length > 0).join(" — ") || "no message";
  } catch {
    return "no message";
  }
}

/**
 * Maps an upstream failure to something safe, split the same way
 * `src/linear/client.ts`'s `upstreamError` is: by whether the server could
 * have processed the request. 401/403/404 never file or write anything, so
 * they are `capability_unavailable`. 422 means GitHub understood the request
 * and refused its content — that refusal is worth surfacing, but GitHub
 * quotes back what was sent, so the message is redacted of dev-env values and
 * bounded before it becomes model-facing. Everything else (network failure,
 * 5xx) is in-doubt: the write may or may not have landed, and `findPR` is the
 * reconciliation, because the branch name decides it.
 */
async function upstreamError(
  response: Response,
  redact: (text: string) => string,
): Promise<CapabilityError> {
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return new CapabilityError(
      "capability_unavailable",
      "GitHub is not authorised, or the repository was not found — nothing was opened.",
    );
  }
  if (response.status === 422) {
    const raw = await readErrorMessage(response);
    const bounded = redact(raw).slice(0, MAX_ERROR_MESSAGE_CHARS).trim();
    return new CapabilityError("invalid_input", `GitHub rejected the request: ${bounded}`);
  }
  return new CapabilityError(
    "upstream_unavailable",
    "GitHub failed while handling the request; whether anything was created is unknown.",
  );
}

/** `atob` decodes to a binary string; re-encode as bytes before UTF-8 decoding. */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Each path segment is encoded on its own, so a legitimate `/` in the path survives. */
function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function extractIdentifiers(body: string): string[] {
  const matches = body.match(IDENTIFIER_PATTERN) ?? [];
  return [...new Set(matches)];
}

type PullListItem = { number: number; html_url: string };

export function makeGithubGateway(
  env: Env,
  config: GithubShipConfig,
  auth: GithubAuthSource,
  clock: () => number,
): GithubGateway {
  // Invariant, not a preference: `dev` is an abandoned branch roughly 1300
  // commits behind, so a PR opened against it is a silent no-op review that
  // nobody will ever see land. Refused at construction so a misconfiguration
  // fails the deploy instead of every PR, quietly, forever.
  if (config.base === "dev") {
    throw new Error(
      'GITHUB_BASE must not be "dev" — it is an abandoned branch far behind staging/main; a PR opened against it would be reviewed by nobody.',
    );
  }

  const redact = makeRedactor(devEnvFor(env));

  async function requireToken(): Promise<{ token: string }> {
    const result = await auth.token(clock());
    if (result !== null) return result;
    const hint = config.author === "on-duty" ? "connect GitHub on the dashboard" : "set MONOREPO_PAT";
    throw new CapabilityError(
      "capability_unavailable",
      `no GitHub credential is available for the configured author (${config.author}) — ${hint}. Nothing was opened.`,
    );
  }

  async function currentLogin(token: string): Promise<string> {
    const res = await githubFetch(token, "GET", `${GITHUB_ORIGIN}/user`);
    if (!res.ok) throw await upstreamError(res, redact);
    const body = (await res.json()) as { login: string };
    return body.login;
  }

  /** `GET pulls?head=<headOwner>:<branch>&state=open` — shared by `openPR`'s ensure step and `findPR`. */
  async function findOpenPull(token: string, branch: string): Promise<PullListItem | null> {
    const headOwner = config.headRepo.split("/")[0];
    const qualifiedHead = `${headOwner}:${branch}`;
    const url = `${GITHUB_ORIGIN}/repos/${config.repo}/pulls?head=${encodeURIComponent(qualifiedHead)}&state=open`;
    const res = await githubFetch(token, "GET", url);
    if (!res.ok) throw await upstreamError(res, redact);
    const list = (await res.json()) as PullListItem[];
    return list[0] ?? null;
  }

  return {
    async openPR(input): Promise<PullRequestRef> {
      const { token } = await requireToken();

      const diff = await readDiffWithBase(env, input.diffRef);
      if (diff === null) {
        throw new CapabilityError(
          "invalid_input",
          `unknown or expired diffRef "${input.diffRef}"; capture a fresh diff and try again.`,
        );
      }
      const { patch, baseSha } = diff;

      // Fetch every path the patch reads from, at the exact base commit the
      // diff was cut against. A 404 here means the base tree lacks a file the
      // patch expects — that path is simply omitted, and `applyUnifiedDiff`
      // below produces the staleness refusal; inventing a second message for
      // the same fact would just be two ways to say one thing.
      const baseMap = new Map<string, string>();
      for (const path of basePaths(patch)) {
        const res = await githubFetch(
          token,
          "GET",
          `${GITHUB_ORIGIN}/repos/${config.headRepo}/contents/${encodeRepoPath(path)}?ref=${baseSha}`,
        );
        if (res.status === 404) continue;
        if (!res.ok) throw await upstreamError(res, redact);
        const body = (await res.json()) as { content?: string };
        if (typeof body.content !== "string") continue;
        baseMap.set(path, decodeBase64Utf8(body.content));
      }

      // Pure, byte-exact, throws its own readable `invalid_input` on staleness.
      const changes = applyUnifiedDiff(patch, baseMap);

      // Blobs, create/modify only — a delete needs no blob, just a tree entry
      // with `sha: null`.
      const blobShas = new Map<string, string>();
      for (const change of changes) {
        if (change.kind === "delete") continue;
        const res = await githubFetch(token, "POST", `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/blobs`, {
          content: change.content,
          encoding: "utf-8",
        });
        if (!res.ok) throw await upstreamError(res, redact);
        const body = (await res.json()) as { sha: string };
        blobShas.set(change.path, body.sha);
      }

      // The base commit's tree is what the new tree is built on top of, so
      // untouched paths carry over without being re-listed here.
      const baseCommitRes = await githubFetch(
        token,
        "GET",
        `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/commits/${baseSha}`,
      );
      if (!baseCommitRes.ok) throw await upstreamError(baseCommitRes, redact);
      const baseCommit = (await baseCommitRes.json()) as { tree: { sha: string } };

      const treeEntries = changes.map((change) =>
        change.kind === "delete"
          ? { path: change.path, mode: "100644" as const, type: "blob" as const, sha: null }
          : {
              path: change.path,
              mode: change.mode,
              type: "blob" as const,
              sha: blobShas.get(change.path),
            },
      );

      const treeRes = await githubFetch(token, "POST", `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries,
      });
      if (!treeRes.ok) throw await upstreamError(treeRes, redact);
      const tree = (await treeRes.json()) as { sha: string };

      const newCommitRes = await githubFetch(token, "POST", `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/commits`, {
        message: input.commitMessage,
        tree: tree.sha,
        parents: [baseSha],
      });
      if (!newCommitRes.ok) throw await upstreamError(newCommitRes, redact);
      const newCommit = (await newCommitRes.json()) as { sha: string };

      // Ref ensure: try to create; a 422 means it already exists, so force it
      // forward with a PATCH instead. GET-then-decide would also work, but
      // costs an extra round trip on the common (first-time) path for no
      // benefit — this way the common case is one request.
      const createRefRes = await githubFetch(token, "POST", `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: newCommit.sha,
      });
      if (createRefRes.status === 422) {
        const patchRefRes = await githubFetch(
          token,
          "PATCH",
          `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/refs/heads/${input.branch}`,
          { sha: newCommit.sha, force: true },
        );
        if (!patchRefRes.ok) throw await upstreamError(patchRefRes, redact);
      } else if (!createRefRes.ok) {
        throw await upstreamError(createRefRes, redact);
      }

      // PR ensure: reconcile against `repo` (never `headRepo` — the PR always
      // opens on the base repo), qualified head so the fork case and the
      // same-repo case are one code path.
      const headOwner = config.headRepo.split("/")[0];
      const qualifiedHead = `${headOwner}:${input.branch}`;
      const existing = await findOpenPull(token, input.branch);

      let pull: { number: number; html_url: string };
      let updated: boolean;
      if (existing) {
        const patchRes = await githubFetch(token, "PATCH", `${GITHUB_ORIGIN}/repos/${config.repo}/pulls/${existing.number}`, {
          title: input.title,
          body: input.body,
        });
        if (!patchRes.ok) throw await upstreamError(patchRes, redact);
        pull = (await patchRes.json()) as { number: number; html_url: string };
        updated = true;
      } else {
        const postRes = await githubFetch(token, "POST", `${GITHUB_ORIGIN}/repos/${config.repo}/pulls`, {
          title: input.title,
          body: input.body,
          head: qualifiedHead,
          base: config.base,
        });
        if (!postRes.ok) throw await upstreamError(postRes, redact);
        pull = (await postRes.json()) as { number: number; html_url: string };
        updated = false;
      }

      const login = await currentLogin(token);

      return { number: pull.number, url: pull.html_url, headRef: input.branch, author: login, updated };
    },

    async findPR(branch): Promise<PullRequestRef | null> {
      const { token } = await requireToken();
      const found = await findOpenPull(token, branch);
      if (found === null) return null;
      const login = await currentLogin(token);
      return { number: found.number, url: found.html_url, headRef: branch, author: login, updated: true };
    },

    async checkPR(number): Promise<PullRequestStatus> {
      const { token } = await requireToken();

      const prRes = await githubFetch(token, "GET", `${GITHUB_ORIGIN}/repos/${config.repo}/pulls/${number}`);
      if (!prRes.ok) throw await upstreamError(prRes, redact);
      const pr = (await prRes.json()) as {
        state: string;
        merged: boolean;
        html_url: string;
        head: { ref: string };
        base: { ref: string };
      };
      const state: PullRequestStatus["state"] = pr.merged ? "merged" : pr.state === "open" ? "open" : "closed";

      const commentsRes = await githubFetch(
        token,
        "GET",
        `${GITHUB_ORIGIN}/repos/${config.repo}/issues/${number}/comments`,
      );
      if (!commentsRes.ok) throw await upstreamError(commentsRes, redact);
      const comments = (await commentsRes.json()) as Array<{ user?: { login?: string } | null; body?: string }>;
      const linkback = comments.find((c) => LINEAR_BOT_LOGIN.test(c.user?.login ?? ""));

      const linearLinkback =
        linkback === undefined
          ? { commented: false, identifiers: [] }
          : { commented: true, identifiers: extractIdentifiers(linkback.body ?? "") };

      return { state, url: pr.html_url, headRef: pr.head.ref, baseRef: pr.base.ref, linearLinkback };
    },
  };
}
