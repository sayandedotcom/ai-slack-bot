import type { ApprovalPort } from "../approval/contracts";
import type { MemoryStore } from "../memory/store";
import type { DiffResult } from "../sandbox/diff";
import type { BootStatus } from "../sandbox/lifecycle";

/**
 * The narrow interfaces the capability layer talks to, and the shapes it hands
 * back to model-authored code.
 *
 * Providers receive these, never the Worker `env`. Two consequences that are
 * the whole point:
 *
 *  - credentials live in the gateway implementation, so a binding file has no
 *    way to reach one even by accident;
 *  - credential *absence* is testable with a fake, so Tasks 6-12 can be written
 *    and reviewed without a live vendor account.
 *
 * Field names here become model-visible type names. Nothing in this file may
 * name a target, an identity, or a credential — `renderCapabilityDeclarations`
 * has a test that greps the generated declarations for exactly that.
 */

/* ------------------------------------------------------------ result shapes -- */

export type SlackMessage = {
  ts: string;
  userId: string | null;
  text: string;
  permalink: string | null;
  /**
   * The stored `messages.event_id`, for HOST use only.
   *
   * It never reaches model-authored code: the Slack binding projects the
   * model-visible shape explicitly and drops this field. It exists so a read
   * can register bounded trusted provenance for the messages it RETURNED,
   * which is what lets a later citation resolve through D1 to the real message
   * rather than to a URL somebody assembled from components.
   *
   * Optional because a gateway may legitimately not have one — a fake in a
   * test, or a future non-D1 source. A missing id registers no provenance,
   * which costs a citation and can never produce a wrong one.
   */
  eventId?: string;
};

export type RecalledFact = {
  factId: string;
  fact: string;
};

/**
 * `channel_id` from the Phase 06 citation resolver is deliberately dropped on
 * the way out: it is a destination identifier, and the model is never shown
 * one. The permalink already points at the exact message.
 */
export type Citation = {
  factId: string;
  fact: string;
  permalink: string;
  ts: string;
};

export type IssueRef = {
  id: string;
  identifier: string;
  url: string;
};

export type ResourceDescription = {
  resource: string;
  columns: Array<{ name: string; type: string }>;
};

/** One row of an allowlisted read. Scalars only — see toSafeJson's depth cap. */
export type Row = Record<string, string | number | boolean | null>;

export type TraceRef = {
  traceId: string;
  name: string;
  startedAt: string;
  status: string;
};

/**
 * A FLAT node list with parent links, never a nested tree.
 *
 * `JsonValue` bottoms out after four levels, so a freely nested tree cannot
 * survive `RunDO.appendToolCallUpdate({ output })` — and that failure is a
 * typecheck error no test can observe, because vitest strips types. Flat is
 * also cheaper to truncate and reconstructible in three lines of model code.
 */
export type TraceNode = {
  id: string;
  parentId: string | null;
  name: string;
  runType: string;
  status: string;
  startedAt: string;
  durationMs: number;
  /** Bounded preview, not the full prompt. */
  inputPreview: string;
  outputPreview: string;
  error: string | null;
};

export type Trace = {
  traceId: string;
  name: string;
  startedAt: string;
  status: string;
  nodes: TraceNode[];
  /** True when nodes were dropped to fit the caps. */
  truncated: boolean;
};

export type LogLine = {
  at: string;
  level: string;
  message: string;
};

export type Monitor = {
  id: string;
  name: string;
  status: string;
  lastCheckedAt: string | null;
};

export type PublishedFile = {
  url: string;
  size: number;
  sha256: string;
};

/* ---------------------------------------------------------------- gateways -- */

export interface SlackGateway {
  /** The current run's conversation, from the D1 system of record. */
  thread(limit: number): Promise<SlackMessage[]>;
  /**
   * `customerSlug` is a REQUIRED argument, not an optional override, and it is
   * always a slug the trusted parent resolved — from the run's own D1 channel
   * policy, or from a reference the host minted after reading the catalog. The
   * gateway can therefore no longer read `scope.customerSlug` itself, which is
   * what makes the Chat discovery path expressible without giving the gateway a
   * second, quieter way to pick a customer.
   */
  searchMessages(
    query: string,
    limit: number,
    customerSlug: string
  ): Promise<SlackMessage[]>;
  /** Post into the current run only. Targeting is not a parameter. */
  reply(
    text: string,
    idempotencyKey: string
  ): Promise<{ ts: string; permalink: string | null }>;
}

export interface LinearGateway {
  createIssue(input: {
    title: string;
    description: string;
    labels: string[];
    idempotencyKey: string;
  }): Promise<IssueRef>;
  /**
   * Did the issue for this key actually get filed?
   *
   * Answerable precisely because the create supplies its own id, so this is an
   * exact lookup rather than a guess. It is what turns an ambiguous 5xx into a
   * decidable question instead of permanent doubt.
   */
  findIssue(idempotencyKey: string): Promise<IssueRef | null>;
  updateIssue(input: {
    issueId: string;
    title?: string;
    description?: string;
    state?: string;
  }): Promise<{ id: string; url: string }>;
  resolveLinkTargets(
    issueIds: string[]
  ): Promise<Array<{ id: string; identifier: string }>>;
  /**
   * Phase 20's answer to "I did not create this issue, but I need to link
   * it": a READ, not a mutation, so it is classified `read` in the binding
   * and never touches the effect ledger. Named `lookupIssue` rather than
   * `findIssue` because that name is already taken on this interface, above,
   * for a different question (did MY create for this idempotency key land?)
   * — the model-facing capability is still called `linear.findIssue`; only
   * this gateway seam needed the different name.
   *
   * Not found returns `null` rather than throwing — an honest answer, since
   * "no such issue" is routine input for a model deciding whether to link
   * something a prior run may have created. Belonging to another team still
   * throws `linear_team_denied`, sharing `requirePinnedIssue`'s exact
   * refusal text rather than a second hand-copied string.
   */
  lookupIssue(identifier: string): Promise<{
    id: string;
    identifier: string;
    url: string;
    title: string;
    state: string;
  } | null>;
}

export interface SupabaseReader {
  describe(resource: string | null): Promise<ResourceDescription[]>;
  select(input: {
    resource: string;
    columns: string[] | null;
    filters: Array<{ column: string; op: string; value: unknown }>;
    order: { column: string; direction: "asc" | "desc" } | null;
    limit: number;
  }): Promise<Row[]>;
}

export interface LangSmithReader {
  trace(traceId: string): Promise<Trace>;
  searchTraces(input: {
    query: string | null;
    since: string | null;
    limit: number;
  }): Promise<TraceRef[]>;
}

export interface BetterStackReader {
  logs(input: {
    query: string;
    since: string;
    until: string | null;
    limit: number;
  }): Promise<LogLine[]>;
  monitors(): Promise<Monitor[]>;
}

/**
 * What a command produced. Already scrubbed of dev-env values by the gateway;
 * bounding it is the binding's job, because the cap is a model-facing promise
 * rather than a property of the container.
 */
export type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxProcessState = {
  running: boolean;
  /** Null while it is still running. */
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
};

/**
 * What `browser.checkRecording` reports on one recording — Phase 19.
 *
 * `state: "failed"` is not an error to be caught and hidden: a script that
 * throws still gets a flushed, playable video out of the harness, and that
 * video is the proof a bug is real. `error` carries Playwright's own message
 * when the script threw, trimmed to the useful part, and the harness's own
 * named refusal (`browser-unavailable`) when the machine's Chromium install
 * never completed — either way the model gets a reason it can act on rather
 * than a bare failure.
 */
export type RecordingStatus = {
  state: "running" | "passed" | "failed";
  /** Public URL, present once state is terminal AND a video was produced. */
  url: string | null;
  error: string | null;
  stdoutTail: string;
  durationMs: number;
};

/**
 * The one run's container, Phase 18.
 *
 * Every method acts on THIS run's machine and no other: there is no id
 * parameter anywhere, because the container is addressed by the run and the
 * model cannot name one. It is the same rule the Slack gateway follows for a
 * destination, applied to a machine.
 *
 * Two obligations this interface carries that its signatures cannot state:
 *
 *  - every text field it returns is already scrubbed of dev-env VALUES. The
 *    implementation holds the secret, so it is the only layer that can, and
 *    the binding above it must never be handed a value to leak;
 *  - `boot` is the readiness read. It is idempotent, so the other methods can
 *    use it as their gate rather than caching a flag that an evicted isolate
 *    would get wrong. `longPoll: true` may hold the call ~14s waiting for
 *    provisioning progress; the BINDING decides when, because "once per
 *    execution" is execution-scoped knowledge and the gateway outlives
 *    executions — two long-polls in one code block is how a 20s budget dies
 *    at 25.7s, observed live in run 29f027e4.
 *
 * `readBinary`, `record` and `checkRecording` are Phase 19's addition, reached
 * from the `browser` namespace rather than `sandbox` — a real browser and its
 * recording are a different model-facing surface than a shell, even though
 * both run on the same container and share this one gate.
 */
export interface SandboxGateway {
  boot(longPoll: boolean): Promise<BootStatus>;
  exec(input: {
    cmd: string;
    cwd?: string;
    timeoutMs: number;
    injectDevEnv: boolean;
  }): Promise<SandboxCommandResult>;
  spawn(input: {
    cmd: string;
    cwd?: string;
    injectDevEnv: boolean;
  }): Promise<{ processId: string }>;
  checkProcess(processId: string): Promise<SandboxProcessState>;
  killProcess(processId: string): Promise<{ killed: boolean }>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<{ bytesWritten: number }>;
  preview(port: number): Promise<{ url: string }>;
  /** Captures the working tree's diff by reference. Never returns the bytes. */
  diff(): Promise<DiffResult>;
  /**
   * Raw binary read of a file in the container, WITH ITS LENGTH. RPC transport
   * only.
   *
   * Phase 19's one caller is `record.ts`: it streams a finished recording
   * straight from the container to R2 without the bytes ever materialising in
   * this Worker's memory, the same shape `diff()` uses for a patch that can
   * run to megabytes.
   *
   * `size` is the container file server's own figure (`ReadFileStreamResult`),
   * so it costs nothing and is known before a byte is read. It is what lets the
   * byte ceiling be enforced up front and the upload be a single
   * `put(key, content.pipeThrough(new FixedLengthStream(size)))` instead of a
   * hand-rolled multipart loop. The plan pinned the narrower
   * `Promise<ReadableStream<Uint8Array>>` for wave-A concurrency and said
   * widening it was a review finding rather than a judgment call; this is that
   * finding, taken.
   */
  readBinary(
    path: string
  ): Promise<{ content: ReadableStream<Uint8Array>; size: number }>;
  /**
   * Start a Playwright recording — Phase 19's `preview`-shaped counterpart:
   * it does not block past the execution budget, it returns a handle, and
   * `checkRecording` is the poll. `script` is Playwright source, not a
   * closure — a function cannot cross the isolate/container boundary.
   */
  record(input: {
    script: string;
    label: string;
    timeoutMs?: number;
  }): Promise<{ recordingId: string }>;
  checkRecording(recordingId: string): Promise<RecordingStatus>;
}

/**
 * Phase 20. What `openPR`/`findPR` hand back — enough for the model to say
 * where the work landed without ever seeing a token or a repo slug it did
 * not itself provide via `branch`.
 */
export type PullRequestRef = {
  number: number;
  url: string;
  headRef: string;
  /** GET /user's login for the authoring token — the identity the PR opened under. */
  author: string;
  /** True when an existing branch/PR was updated rather than created. */
  updated: boolean;
};

export type PullRequestStatus = {
  state: "open" | "closed" | "merged";
  url: string;
  headRef: string;
  baseRef: string;
  /** The linear-code bot's linkback receipt: present, and which identifiers it names. */
  linearLinkback: { commented: boolean; identifiers: string[] };
};

/**
 * One hit from a PR search. Deliberately the SEARCH endpoint's shape and no
 * more — it does not carry the head branch, so a caller who needs that (or the
 * linkback) follows up with `checkPR(number)`. Enriching every hit here would
 * be one extra request per result for a field most questions do not need.
 */
export type PullRequestMatch = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  /** GitHub login of the PR's author. */
  author: string;
  /** ISO-8601, GitHub's `updated_at`. */
  updatedAt: string;
};

/**
 * Phase 20's transport to GitHub: blobs → tree → commit → ref → PR, with
 * ensure semantics throughout so a retried call reconciles instead of
 * duplicating. Implemented in `src/git/commit.ts`; no body-rendering or PR
 * convention lives here or there — `body` arrives fully rendered.
 */
export interface GithubGateway {
  openPR(input: {
    branch: string;
    title: string;
    commitMessage: string;
    /** Fully rendered by the BINDING (conventions are policy); the gateway is transport. */
    body: string;
    diffRef: string;
    idempotencyKey: string;
  }): Promise<PullRequestRef>;
  /** Reconcile: the open PR whose head is `branch`, or null. */
  findPR(branch: string): Promise<PullRequestRef | null>;
  checkPR(number: number): Promise<PullRequestStatus>;
  /**
   * PRs in the pinned repo matching free text (title and body), newest
   * activity first. Any state. `limit` is already validated by the binding.
   */
  searchPRs(query: string, limit: number): Promise<PullRequestMatch[]>;
}

export interface ArtifactPublisher {
  publish(input: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    idempotencyKey: string;
  }): Promise<PublishedFile>;
}

/**
 * Everything a capability may reach. Deliberately not `Env`: a binding file
 * that wanted a credential would have to change this type first, in a diff.
 */
export type CapabilityDependencies = {
  db: D1Database;
  slack: SlackGateway;
  /** The shipped Phase 06 seam, reused rather than paralleled. */
  memory: MemoryStore;
  linear: LinearGateway;
  supabase: SupabaseReader;
  langsmith: LangSmithReader;
  betterstack: BetterStackReader;
  files: ArtifactPublisher;
  /**
   * Phase 11's seam. The `approval` capability namespace calls this and
   * nothing else — never D1, never the RunDO's own storage directly. The real
   * storage-backed implementation is a later task's; this port exists so the
   * capability layer can be built and reviewed against a test double first.
   */
  approval: ApprovalPort;
  /**
   * Phase 18's seam, and the reason the `sandbox` binding can stay a pure
   * model-facing surface. The container modules (`src/sandbox/*`) take the
   * Worker `env` — they hold a PAT, a dev-env secret and an R2 bucket — so
   * reaching them from a binding directly would put `Env` inside
   * `src/codemode/`, which is the one thing this type exists to prevent.
   */
  sandbox: SandboxGateway;
  /**
   * Phase 20's seam for the same reason `sandbox` is one: `src/git/commit.ts`
   * holds a PAT or an on-duty identity's decrypted token, so reaching it from
   * a binding directly would put `Env` inside `src/codemode/` again.
   */
  github: GithubGateway;
  clock: () => number;
};
