import type { Env } from "../index";
import { CapabilityError } from "../gateways/errors";
import type {
  GithubGateway,
  PullRequestMatch,
  PullRequestRef,
  PullRequestStatus,
} from "../gateways/ports";
import { applyUnifiedDiff, basePaths } from "./apply";
import { readDiffWithBase } from "../sandbox/diff";
import { devEnvFor } from "../sandbox/env";
import { makeRedactor } from "../sandbox/gateway";
import { MONOREPO_SLUG } from "../sandbox/class";
import { getDecryptedToken } from "../identity/tokens";
import { resolveSpeaker } from "../identity/speaker";

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

/**
 * How many comment pages `checkPR` will walk before giving up. 100 per page
 * (GitHub's own maximum) times this cap is 1,000 comments — far past any real
 * PR, and a hard ceiling so a pathological `Link` header cannot loop forever.
 */
const MAX_COMMENT_PAGES = 10;

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
  return { repo, headRepo, base, author: resolveAuthor(env.GITHUB_AUTHOR) };
}

/**
 * ABSENT defaults; UNRECOGNISED refuses.
 *
 * The two are different facts and must not share an outcome. The documented
 * handover for the live drill is "flip one var to `on-duty`" — and a value
 * that merely FAILS to be `on-duty` (`onduty`, `On-Duty`, a stray character)
 * used to coerce silently back to the worker PAT, with no signal at deploy
 * time at all: the first observation would be a pull request already open on
 * the monorepo under the wrong identity. Refused by name at construction, the
 * same way `GITHUB_BASE === "dev"` is refused in `makeGithubGateway` below.
 *
 * Absence still defaults to `worker-pat`, because that IS the documented
 * default and `wrangler.jsonc` may legitimately omit the var.
 */
function resolveAuthor(raw: string | undefined): "on-duty" | "worker-pat" {
  const value = raw?.trim();
  if (value === undefined || value === "") return "worker-pat";
  if (value === "on-duty" || value === "worker-pat") return value;
  throw new Error(
    `GITHUB_AUTHOR must be "on-duty" or "worker-pat"; got ${JSON.stringify(raw)}. ` +
      "Refused rather than defaulted: a typo here would open pull requests on the monorepo under the worker PAT with no other signal that the handover did not take."
  );
}

/**
 * The `on-duty` / `worker-pat` chain, mirroring `src/identity/user-token.ts`'s
 * speaker → identity row → decrypted token pattern exactly, narrowed to just
 * the token this gateway needs. (`on-duty` is the var's historical value; since
 * 2026-08-17 there is no shift, and it means "the default speaker's own GitHub
 * token" — the first fire-fighter in roster order who has connected GitHub.)
 *
 * `worker-pat` never touches D1 or the roster — it is a single Worker secret,
 * present or not. `on-duty` never falls back to `worker-pat` on a missing
 * credential: a missing credential is an honest refusal, not a silent switch to
 * a different identity's authority.
 */
export function makeGithubAuthSource(
  env: Env,
  config: GithubShipConfig
): GithubAuthSource {
  return {
    async token(nowMs: number): Promise<{ token: string } | null> {
      if (config.author === "worker-pat") {
        const pat = env.MONOREPO_PAT;
        return pat ? { token: pat } : null;
      }

      const speaker = await resolveSpeaker(env.DB, "github");
      if (!speaker) return null;

      const token = await getDecryptedToken(env, speaker.email, "github");
      return token ? { token } : null;
    },
  };
}

/**
 * Git's own ref-name rules, enforced BEFORE any GitHub request. This module
 * is the last thing before a write to a real company repository, so it must
 * not lean on its caller's own validation (Task 4's binding validates too,
 * but this one is the one that actually has to hold — a model-supplied
 * branch reaches here regardless of what validated it upstream).
 *
 * Refusing `..` anywhere, a leading/trailing `/`, and anything outside a
 * conservative character set closes path traversal at the source: a branch
 * that fails this check never reaches a URL, so it does not matter that
 * `.` is not a character `encodeURIComponent` escapes. The encoding done at
 * each call site is defense in depth on top of this, not instead of it.
 */
const VALID_BRANCH_CHARS = /^[A-Za-z0-9._\-/]+$/;

function assertValidBranch(branch: string): void {
  const invalid =
    branch.length === 0 ||
    !VALID_BRANCH_CHARS.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.endsWith(".lock");
  if (invalid) {
    throw new CapabilityError(
      "invalid_input",
      `"${branch}" is not a valid branch name; refused before any request was made.`
    );
  }
}

/**
 * The same discipline as `assertValidBranch`, for the other value this module
 * interpolates into GitHub URLs — `baseSha` reaches a query string (`?ref=`)
 * and a URL PATH (`/git/commits/${baseSha}`, `/compare/${base}...${baseSha}`).
 *
 * It arrives from R2 `customMetadata` via `readDiffWithBase`, which does no
 * shape check of its own, and the only validation that exists today lives one
 * module away in `src/sandbox/gateway.ts`'s `diff()` — in the CALLER of an
 * exported `captureDiff(env, runId, raw, baseSha)` that validates nothing. So
 * the check that has to hold is this one, for exactly the reason the
 * `assertValidBranch` note above gives: this file is the last thing before a
 * write to a real company repository and must not lean on a caller's
 * validation. Not exploitable today; one future `captureDiff` caller reopens
 * it, and that caller will not think to look here.
 *
 * 40 lowercase hex, matching `git rev-parse HEAD`'s own output exactly — an
 * abbreviated sha is refused too, because the commit this parents on must be
 * the exact tree the diff was cut against.
 */
const VALID_SHA = /^[0-9a-f]{40}$/;

function assertValidSha(sha: string): void {
  if (!VALID_SHA.test(sha)) {
    throw new CapabilityError(
      "invalid_input",
      `the stored diff names a base commit that is not a 40-character sha; refused before any request was made. Capture a fresh diff and try again.`
    );
  }
}

/**
 * Same discipline as `assertValidBranch`, for the paths a stored diff names.
 * The diff is Worker-produced, not directly model-authored, but this module
 * is still the last line before a URL is built from one of its paths — a
 * `..` segment must never reach `encodeRepoPath`, because per-segment
 * percent-encoding does not touch `.` and so does not stop traversal on its
 * own.
 */
function assertSafeRepoPath(path: string): void {
  const segments = path.split("/");
  const unsafe =
    path.length === 0 ||
    segments.some((seg) => seg === "" || seg === "." || seg === "..");
  if (unsafe) {
    throw new CapabilityError(
      "invalid_input",
      `the diff touches an unsafe path "${path}"; refused before any request was made.`
    );
  }
}

/**
 * `checkPR`'s `number` is typed `number` in `GithubGateway`, but that type is
 * ERASED at runtime — model-authored code calling through the codemode
 * boundary can hand this function anything JSON can carry, and TypeScript
 * gives no protection at the call site. `number` is interpolated into TWO
 * URL paths (the PR read here, and the comments read inside
 * `fetchAllComments`), so a string like `"42/../../../../repos/other/private/pulls/1"`
 * would normalize through `new URL` into an arbitrary authenticated GET —
 * the same shape `assertValidBranch` closes for `openPR`/`findPR`, applied
 * here to the one remaining untrusted interpolation site. Checked as a
 * runtime value, not trusted from its type: `typeof` first, then integer,
 * positive, and finite/safe so it cannot smuggle `Infinity`, `NaN`, or a
 * float that would still print as a URL-breaking string.
 */
function assertValidPrNumber(value: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CapabilityError(
      "invalid_input",
      `${JSON.stringify(value)} is not a valid pull request number; refused before any request was made.`
    );
  }
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
  body?: unknown
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
      "GitHub could not be reached; whether anything was created is unknown."
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
    return (
      [body.message, extra]
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" — ") || "no message"
    );
  } catch {
    return "no message";
  }
}

/**
 * What to say — and how to CLASSIFY — when a failure happens AFTER the branch
 * has already been pushed. Threaded through from the point the ref-ensure step
 * actually succeeds, so a PR-ensure failure past that point cannot claim
 * "nothing was opened" about a commit that is sitting on the company repo, and
 * cannot record it in the effects ledger as if nothing had been sent. See
 * `upstreamError` below for the classification half.
 */
type WrittenContext = { branch: string; headRepo: string };

function reconcileHint(ctx: WrittenContext): string {
  return `branch "${ctx.branch}" was already pushed to ${ctx.headRepo}, but the pull request was not opened. Call findPR("${ctx.branch}") to reconcile before retrying — do not push again.`;
}

/**
 * Maps an upstream failure to something safe, split the same way
 * `src/linear/client.ts`'s `upstreamError` is: by whether the server could
 * have processed the request. 401/403/404 never file or write anything, so
 * they are `capability_unavailable`; 422 means GitHub understood the request
 * and refused its content, which is `invalid_input` — that refusal is worth
 * surfacing, but GitHub quotes back what was sent, so the message is redacted
 * of dev-env values and bounded before it becomes model-facing. Everything
 * else (network failure, 5xx) is in-doubt: the write may or may not have
 * landed, and `findPR` is the reconciliation, because the branch name decides
 * it.
 *
 * `written` overrides the CODE, not just the wording. Both
 * `capability_unavailable` and `invalid_input` are members of
 * `PROVEN_PRE_UPSTREAM` in `src/codemode/effects.ts` — the set documented as
 * "codes that prove the call was refused BEFORE anything left this Worker" —
 * so `performClaimed` writes the ledger row `failed`, whose stated meaning is
 * that a retry is safe because nothing was sent. That is a lie once the branch
 * is pushed: the commit is on the company repo, and a human reading that row
 * is told the opposite of what happened. `upstream_unavailable` is outside
 * that set on purpose (the file's own asymmetry note: an unproven send costs a
 * human a look, a mis-proved one costs a customer), so the row becomes
 * `in_doubt` and the binding's `reconcile` — `findPR(branch)` — resolves it.
 * The improved wording from `reconcileHint` is kept as-is on top.
 */
async function upstreamError(
  response: Response,
  redact: (text: string) => string,
  written?: WrittenContext
): Promise<CapabilityError> {
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return new CapabilityError(
      written ? "upstream_unavailable" : "capability_unavailable",
      written
        ? `GitHub is not authorised, or the pull request endpoint was not found. ${reconcileHint(written)}`
        : "GitHub is not authorised, or the repository was not found — nothing was opened."
    );
  }
  if (response.status === 422) {
    const raw = await readErrorMessage(response);
    const bounded = redact(raw).slice(0, MAX_ERROR_MESSAGE_CHARS).trim();
    return new CapabilityError(
      written ? "upstream_unavailable" : "invalid_input",
      written
        ? `GitHub rejected the request. ${reconcileHint(written)} GitHub said: ${bounded}`
        : `GitHub rejected the request: ${bounded}`
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    written
      ? `GitHub failed while handling the request. ${reconcileHint(written)}`
      : "GitHub failed while handling the request; whether anything was created is unknown."
  );
}

/** `atob` decodes to a binary string; re-encode as bytes before UTF-8 decoding. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode a fetched base file, or refuse it — never approximate it.
 *
 * `new TextDecoder("utf-8")` is NON-FATAL: every byte it cannot interpret
 * becomes U+FFFD and the decode "succeeds". Git only calls a file binary if it
 * finds a NUL in the first 8 KB, so a latin-1 (or otherwise non-UTF-8) TEXT
 * file diffs as text, sails past the applier's binary refusal, and every
 * invalid byte in it would be committed as U+FFFD — corrupting lines the fix
 * never touched, on a real monorepo, with no human in between.
 *
 * The applier's byte-exact context check cannot catch it: the patch text
 * arrives through the container's stdout mangled exactly the same way, so both
 * sides agree on the wrong bytes. The only thing that can catch it is asking
 * whether the decode is REVERSIBLE — re-encode the decoded string and compare
 * against the bytes that were fetched. Per invariant 6, refusing is correct
 * here and approximating is not.
 *
 * `ignoreBOM: true` keeps a leading U+FEFF as content rather than silently
 * eating it, which is the same corruption in miniature: a stripped BOM would
 * round-trip short, and a file that legitimately starts with one must ship
 * byte-identical.
 */
function decodeBase64Utf8(base64: string, path: string): string {
  const bytes = base64ToBytes(base64);
  // `fatal: false` is stated rather than inherited: the round trip below is
  // what decides, and a throwing decoder would report the same fact as an
  // untyped `TypeError` instead of a named refusal.
  const text = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true,
  }).decode(bytes);
  const reencoded = new TextEncoder().encode(text);
  const identical =
    reencoded.length === bytes.length &&
    reencoded.every((byte, i) => byte === bytes[i]);
  if (!identical) {
    throw new CapabilityError(
      "invalid_input",
      `"${path}" is not valid UTF-8, so it cannot be modified byte-exactly through this path — an automated apply would rewrite every undecodable byte in the file, including on lines this change never touches. It needs a human pull request.`
    );
  }
  return text;
}

/** Each path segment is encoded on its own, so a legitimate `/` in the path survives. */
function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Same per-segment encoding as `encodeRepoPath`, named separately because a branch and a repo path are validated by different rules above. */
function encodeBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function extractIdentifiers(body: string): string[] {
  const matches = body.match(IDENTIFIER_PATTERN) ?? [];
  return [...new Set(matches)];
}

/** The URL `Link: <url>; rel="next"` header points at, or null on the last page. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

type PullListItem = { number: number; html_url: string };
type Comment = { user?: { login?: string } | null; body?: string };

export function makeGithubGateway(
  env: Env,
  config: GithubShipConfig,
  auth: GithubAuthSource,
  clock: () => number
): GithubGateway {
  // Invariant, not a preference: `dev` is an abandoned branch roughly 1300
  // commits behind, so a PR opened against it is a silent no-op review that
  // nobody will ever see land. Refused at construction — every gateway built
  // for this run fails immediately rather than opening a PR nobody reviews.
  if (config.base === "dev") {
    throw new Error(
      'GITHUB_BASE must not be "dev" — it is an abandoned branch far behind staging/main; a PR opened against it would be reviewed by nobody.'
    );
  }

  const redact = makeRedactor(devEnvFor(env));

  async function requireToken(): Promise<{ token: string }> {
    const result = await auth.token(clock());
    if (result !== null) return result;
    const hint =
      config.author === "on-duty"
        ? "connect GitHub on the dashboard"
        : "set MONOREPO_PAT";
    throw new CapabilityError(
      "capability_unavailable",
      `no GitHub credential is available for the configured author (${config.author}) — ${hint}. Nothing was opened.`
    );
  }

  /**
   * No `written` parameter, unlike `findOpenPull` below: both call sites now
   * read `/user` BEFORE anything is written, so there is no post-write failure
   * for this call to describe.
   */
  async function currentLogin(token: string): Promise<string> {
    const res = await githubFetch(token, "GET", `${GITHUB_ORIGIN}/user`);
    if (!res.ok) throw await upstreamError(res, redact);
    const body = (await res.json()) as { login: string };
    return body.login;
  }

  /**
   * THE COUPLING NOTHING ELSE ENFORCES: what the sandbox checked out vs. what
   * the pull request opens against.
   *
   * `src/sandbox/lifecycle.ts`'s `REPO_REF` decides the working tree — and
   * therefore `baseSha`, the commit this whole method builds on. `GITHUB_BASE`
   * decides the PR's base. Those are two independent knobs that agree today
   * only by a coincidence of defaults (both `staging`), and Task 6 of the
   * phase plan deliberately breaks the agreement to plant a bug for the live
   * drill.
   *
   * One direction of the mismatch is merely wasteful. The other ships a bug:
   * with the sandbox on a planted branch and `GITHUB_BASE` still `staging`,
   * the PR's three-dot diff contains the planted commits, and MERGING IT LANDS
   * THEM ON STAGING. Nothing downstream notices — the only signal is a
   * reviewer thinking the diff looks suspiciously large.
   *
   * So it is answered by a request rather than by a comment, because a comment
   * cannot stop a merge and one extra read can. `GET /compare/{base}...{head}`
   * reports `status` from the HEAD's point of view: `identical` (same commit),
   * `behind` (head is an ancestor of base — contained), `ahead` (head carries
   * commits base does not have), `diverged` (both). Containment is therefore
   * exactly `identical` or `behind`; the other two are refused by name.
   *
   * Normal operation is `behind`/`identical` and passes. The drill's
   * deliberate override — sandbox AND `GITHUB_BASE` both on the planted branch
   * — is `identical` and passes. Only the dangerous direction is refused.
   */
  async function assertBaseContains(
    token: string,
    baseSha: string
  ): Promise<void> {
    const url = `${GITHUB_ORIGIN}/repos/${config.repo}/compare/${encodeBranchPath(config.base)}...${baseSha}`;
    const res = await githubFetch(token, "GET", url);
    if (!res.ok) throw await upstreamError(res, redact);
    const body = (await res.json()) as { status?: string };
    if (body.status === "identical" || body.status === "behind") return;
    throw new CapabilityError(
      "invalid_input",
      `the working tree was cut from commit ${baseSha}, which is not contained in "${config.base}" on ${config.repo} (GitHub compares them as "${body.status ?? "unknown"}"). A pull request from it would carry every commit that is on ${baseSha} and not on "${config.base}", so merging it would land them there. Nothing was pushed. Either point the sandbox at "${config.base}", or set GITHUB_BASE to the branch the sandbox actually checks out.`
    );
  }

  /** `GET pulls?head=<headOwner>:<branch>&state=open` — shared by `openPR`'s ensure step and `findPR`. */
  async function findOpenPull(
    token: string,
    branch: string,
    written?: WrittenContext
  ): Promise<PullListItem | null> {
    const headOwner = config.headRepo.split("/")[0];
    const qualifiedHead = `${headOwner}:${branch}`;
    const url = `${GITHUB_ORIGIN}/repos/${config.repo}/pulls?head=${encodeURIComponent(qualifiedHead)}&state=open&per_page=100`;
    const res = await githubFetch(token, "GET", url);
    if (!res.ok) throw await upstreamError(res, redact, written);
    const list = (await res.json()) as PullListItem[];
    return list[0] ?? null;
  }

  /**
   * Every comment, walking `Link: rel="next"` rather than trusting the first
   * page. GitHub's default page size is 30 and this asks for 100, but a PR
   * can still carry more than that — and `commented: false` on a linkback
   * that actually exists is a false negative the model would act on, sending
   * it to re-request a link it already has.
   */
  async function fetchAllComments(
    token: string,
    number: number
  ): Promise<Comment[]> {
    const out: Comment[] = [];
    let url: string | null =
      `${GITHUB_ORIGIN}/repos/${config.repo}/issues/${number}/comments?per_page=100`;
    let pages = 0;
    while (url !== null && pages < MAX_COMMENT_PAGES) {
      pages += 1;
      const res: Response = await githubFetch(token, "GET", url);
      if (!res.ok) throw await upstreamError(res, redact);
      out.push(...((await res.json()) as Comment[]));
      // `Link` is a RESPONSE header -- following it unchecked would mean a
      // credentialed request going wherever api.github.com's reply points,
      // the same "an origin that can be supplied is an origin that can be
      // redirected" shape `GITHUB_ORIGIN` being a fixed constant exists to
      // prevent. Stop paginating rather than leave the pinned origin.
      const next = nextPageUrl(res.headers.get("Link"));
      url = next !== null && next.startsWith(`${GITHUB_ORIGIN}/`) ? next : null;
    }
    return out;
  }

  return {
    async openPR(input): Promise<PullRequestRef> {
      // `input.idempotencyKey` is required by the pinned `GithubGateway`
      // interface, accepted, and deliberately unused: GitHub's REST API has no
      // idempotency token on any endpoint this method calls. What makes a
      // repeated open safe is the ensure semantics below (create-or-force the
      // ref, then reconcile the PR by head ref), not a header. The parameter
      // stays because the ledger in `src/codemode/effects.ts` hands the same
      // key to every capability and the interface is pinned across namespaces.
      //
      // Validated before any request — including before the diff is even
      // read out of R2. `input.branch` is the one value in this whole method
      // an attacker-controlled model can put arbitrary bytes into, and it
      // gets interpolated into a URL path further down (the force-PATCH ref
      // update); a `..`-laden branch must never get that far.
      assertValidBranch(input.branch);

      const { token } = await requireToken();

      const diff = await readDiffWithBase(env, input.diffRef);
      if (diff === null) {
        throw new CapabilityError(
          "invalid_input",
          `unknown or expired diffRef "${input.diffRef}"; capture a fresh diff and try again.`
        );
      }
      const { patch, baseSha } = diff;
      // As early as the value exists — it comes out of R2 metadata unchecked,
      // and everything below interpolates it into a URL. See `assertValidSha`.
      assertValidSha(baseSha);

      // Path validation first, for the whole patch, so a traversal-shaped path
      // is refused before ANY request is made rather than after a few of them.
      const paths = basePaths(patch);
      for (const path of paths) assertSafeRepoPath(path);

      await assertBaseContains(token, baseSha);

      // Fetch every path the patch reads from, at the exact base commit the
      // diff was cut against. A 404 here means the base tree lacks a file the
      // patch expects — that path is simply omitted, and `applyUnifiedDiff`
      // below produces the staleness refusal; inventing a second message for
      // the same fact would just be two ways to say one thing.
      const baseMap = new Map<string, string>();
      for (const path of paths) {
        const res = await githubFetch(
          token,
          "GET",
          `${GITHUB_ORIGIN}/repos/${config.headRepo}/contents/${encodeRepoPath(path)}?ref=${baseSha}`
        );
        if (res.status === 404) continue;
        if (!res.ok) throw await upstreamError(res, redact);
        const body = (await res.json()) as {
          content?: string;
          encoding?: string;
        };
        // A 200 that is not a base64 payload is a REFUSAL, never a skip. The
        // case that matters is a file between 1 MB and 100 MB: the contents
        // API answers those with `encoding: "none"` and `content: ""`, and
        // accepting that empty string hands the applier a file it believes is
        // empty — which then reports "the diff is stale; re-run diff and try
        // again" for a file that is merely too large. That is a road with no
        // end: every re-run produces the same patch and the same message.
        if (body.encoding !== "base64" || typeof body.content !== "string") {
          throw new CapabilityError(
            "invalid_input",
            `"${path}" could not be read as base64 through GitHub's contents API (encoding: ${JSON.stringify(body.encoding ?? null)}) — a file over 1 MB is not served that way. This change needs a human pull request; capturing the diff again will not help.`
          );
        }
        baseMap.set(path, decodeBase64Utf8(body.content, path));
      }

      // Pure, byte-exact, throws its own readable `invalid_input` on staleness.
      const changes = applyUnifiedDiff(patch, baseMap);

      // Resolved BEFORE the first write, not after the last one. It is only
      // used to fill in `author` on the way out, and reading it afterwards
      // meant a transient `/user` failure discarded a pull request that
      // definitively exists.
      const login = await currentLogin(token);

      // Blobs, create/modify only — a delete needs no blob, just a tree entry
      // with `sha: null`.
      const blobShas = new Map<string, string>();
      for (const change of changes) {
        if (change.kind === "delete") continue;
        const res = await githubFetch(
          token,
          "POST",
          `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/blobs`,
          {
            content: change.content,
            encoding: "utf-8",
          }
        );
        if (!res.ok) throw await upstreamError(res, redact);
        const body = (await res.json()) as { sha: string };
        blobShas.set(change.path, body.sha);
      }

      // The base commit's tree is what the new tree is built on top of, so
      // untouched paths carry over without being re-listed here.
      const baseCommitRes = await githubFetch(
        token,
        "GET",
        `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/commits/${baseSha}`
      );
      if (!baseCommitRes.ok) throw await upstreamError(baseCommitRes, redact);
      const baseCommit = (await baseCommitRes.json()) as {
        tree: { sha: string };
      };

      // `sha: null` is written EXPLICITLY for a delete, never left to
      // `blobShas.get()`'s `undefined` on a lookup miss: `JSON.stringify`
      // drops `undefined` keys silently, which would serialize as an entry
      // with no `sha` at all — and GitHub leaves the file in place rather
      // than deleting it. A missing key and an explicit `null` are the same
      // shape to `toEqual` in a test but very different requests on the wire.
      const treeEntries = changes.map((change) =>
        change.kind === "delete"
          ? {
              path: change.path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: null,
            }
          : {
              path: change.path,
              mode: change.mode,
              type: "blob" as const,
              sha: blobShas.get(change.path),
            }
      );

      const treeRes = await githubFetch(
        token,
        "POST",
        `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/trees`,
        {
          base_tree: baseCommit.tree.sha,
          tree: treeEntries,
        }
      );
      if (!treeRes.ok) throw await upstreamError(treeRes, redact);
      const tree = (await treeRes.json()) as { sha: string };

      const newCommitRes = await githubFetch(
        token,
        "POST",
        `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/commits`,
        {
          message: input.commitMessage,
          tree: tree.sha,
          parents: [baseSha],
        }
      );
      if (!newCommitRes.ok) throw await upstreamError(newCommitRes, redact);
      const newCommit = (await newCommitRes.json()) as { sha: string };

      // Ref ensure: try to create; a 422 means it already exists, so force it
      // forward with a PATCH instead. GET-then-decide would also work, but
      // costs an extra round trip on the common (first-time) path for no
      // benefit — this way the common case is one request.
      //
      // `written` is set ONLY once a ref write actually succeeds (the 201
      // create, or the follow-up PATCH after a 422) — never on the 422 alone,
      // because a 422 just means a ref exists at SOME sha, not that our
      // commit is now reachable from it. Everything below this point that can
      // fail passes `written` through, so a later failure's message reflects
      // reality: the branch is on the repo, only the PR step is unresolved.
      let written: WrittenContext | undefined;
      // Whether the BRANCH already existed. `PullRequestRef.updated` is
      // documented as "an existing branch/PR was updated rather than created",
      // and a human reads that field: a force-update of an existing branch is
      // not a creation, even when the pull request itself is new.
      let refExisted = false;
      const createRefRes = await githubFetch(
        token,
        "POST",
        `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/refs`,
        {
          ref: `refs/heads/${input.branch}`,
          sha: newCommit.sha,
        }
      );
      if (createRefRes.ok) {
        written = { branch: input.branch, headRepo: config.headRepo };
      } else if (createRefRes.status === 422) {
        refExisted = true;
        const patchRefRes = await githubFetch(
          token,
          "PATCH",
          `${GITHUB_ORIGIN}/repos/${config.headRepo}/git/refs/heads/${encodeBranchPath(input.branch)}`,
          { sha: newCommit.sha, force: true }
        );
        if (!patchRefRes.ok) throw await upstreamError(patchRefRes, redact);
        written = { branch: input.branch, headRepo: config.headRepo };
      } else {
        throw await upstreamError(createRefRes, redact);
      }

      // PR ensure: reconcile against `repo` (never `headRepo` — the PR always
      // opens on the base repo), qualified head so the fork case and the
      // same-repo case are one code path.
      const headOwner = config.headRepo.split("/")[0];
      const qualifiedHead = `${headOwner}:${input.branch}`;
      const existing = await findOpenPull(token, input.branch, written);

      let pull: { number: number; html_url: string };
      let updated: boolean;
      if (existing) {
        const patchRes = await githubFetch(
          token,
          "PATCH",
          `${GITHUB_ORIGIN}/repos/${config.repo}/pulls/${existing.number}`,
          {
            title: input.title,
            body: input.body,
          }
        );
        if (!patchRes.ok) throw await upstreamError(patchRes, redact, written);
        pull = (await patchRes.json()) as { number: number; html_url: string };
        updated = true;
      } else {
        const postRes = await githubFetch(
          token,
          "POST",
          `${GITHUB_ORIGIN}/repos/${config.repo}/pulls`,
          {
            title: input.title,
            body: input.body,
            head: qualifiedHead,
            base: config.base,
          }
        );
        if (!postRes.ok) throw await upstreamError(postRes, redact, written);
        pull = (await postRes.json()) as { number: number; html_url: string };
        updated = refExisted;
      }

      return {
        number: pull.number,
        url: pull.html_url,
        headRef: input.branch,
        author: login,
        updated,
      };
    },

    async findPR(branch): Promise<PullRequestRef | null> {
      assertValidBranch(branch);
      const { token } = await requireToken();
      const found = await findOpenPull(token, branch);
      if (found === null) return null;
      const login = await currentLogin(token);
      return {
        number: found.number,
        url: found.html_url,
        headRef: branch,
        author: login,
        updated: true,
      };
    },

    async checkPR(number): Promise<PullRequestStatus> {
      assertValidPrNumber(number);
      const { token } = await requireToken();

      const prRes = await githubFetch(
        token,
        "GET",
        `${GITHUB_ORIGIN}/repos/${config.repo}/pulls/${number}`
      );
      if (!prRes.ok) throw await upstreamError(prRes, redact);
      const pr = (await prRes.json()) as {
        state: string;
        merged: boolean;
        html_url: string;
        head: { ref: string };
        base: { ref: string };
      };
      const state: PullRequestStatus["state"] = pr.merged
        ? "merged"
        : pr.state === "open"
          ? "open"
          : "closed";

      const comments = await fetchAllComments(token, number);
      const linkback = comments.find((c) =>
        LINEAR_BOT_LOGIN.test(c.user?.login ?? "")
      );

      const linearLinkback =
        linkback === undefined
          ? { commented: false, identifiers: [] }
          : {
              commented: true,
              identifiers: extractIdentifiers(linkback.body ?? ""),
            };

      return {
        state,
        url: pr.html_url,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        linearLinkback,
      };
    },

    async searchPRs(query, limit): Promise<PullRequestMatch[]> {
      const { token } = await requireToken();

      // The repo qualifier is OURS, prepended server-side, and the model's text
      // is appended as plain words: a `repo:` or `org:` in the query cannot
      // widen the search past the pinned repository, because GitHub ANDs
      // qualifiers and the pinned one is always present. `is:pr` keeps issues
      // out — this endpoint returns both otherwise. `advanced_search=true` is
      // the syntax GitHub kept when it retired the legacy issue search in
      // 2025; verified live against the real repo before this was written.
      const params = new URLSearchParams({
        q: `is:pr repo:${config.repo} ${query}`,
        sort: "updated",
        order: "desc",
        per_page: String(limit),
        advanced_search: "true",
      });
      const res = await githubFetch(
        token,
        "GET",
        `${GITHUB_ORIGIN}/search/issues?${params}`
      );
      if (!res.ok) throw await upstreamError(res, redact);
      const body = (await res.json()) as {
        items?: Array<{
          number: number;
          title: string;
          state: string;
          html_url: string;
          updated_at: string;
          user?: { login?: string } | null;
          pull_request?: { merged_at?: string | null } | null;
        }>;
      };
      return (body.items ?? []).map((item) => ({
        number: item.number,
        title: item.title,
        // The search shape says `closed` for merged too; `merged_at` is the tell.
        state: item.pull_request?.merged_at
          ? "merged"
          : item.state === "open"
            ? "open"
            : "closed",
        url: item.html_url,
        author: item.user?.login ?? "",
        updatedAt: item.updated_at,
      }));
    },
  };
}
