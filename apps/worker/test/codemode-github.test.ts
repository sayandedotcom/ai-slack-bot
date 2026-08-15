import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRegistry, capabilityEffectOf, PHASE_09_NAMESPACES } from "../src/codemode/registry";
import { CapabilityError } from "../src/codemode/errors";
import { renderPrBody } from "../src/codemode/bindings/github";
import type {
  CapabilityDependencies,
  PullRequestStatus,
} from "../src/codemode/gateways";
import { fakeAuditSink, fakeDeps, seedPermittedScope, TEST_LIMITS, testExecution } from "./helpers/codemode";

/**
 * THE `github` NAMESPACE — Phase 20 Task 4, the conventions wall.
 *
 * Every case here runs against STUBBED `LinearGateway` and `GithubGateway`
 * doubles — never a live token, never a network call — because what this file
 * has to prove lives entirely in the binding: the exact body shape, the
 * attribution refusals, the effect key's contents, and that a Linear refusal
 * (`linear_team_denied`, `invalid_input`) surfaces untouched rather than being
 * caught and reworded. `openPR` runs through the real effect ledger (real D1,
 * via `seedPermittedScope`) because that ledger behavior — replay, in-doubt,
 * reconcile — is exactly what proves the effect key is right.
 */

type Linear = CapabilityDependencies["linear"];
type Github = CapabilityDependencies["github"];

async function githubTools(
  overrides: { linear?: Partial<Linear>; github?: Partial<Github> } = {},
) {
  const scope = await seedPermittedScope(env.DB);
  const base = fakeDeps();
  const deps: CapabilityDependencies = {
    ...base,
    db: env.DB,
    linear: { ...base.linear, ...overrides.linear },
    github: { ...base.github, ...overrides.github },
  };
  const tools = buildRegistry(scope, deps, TEST_LIMITS, testExecution({ audit: fakeAuditSink() }))
    .find((p) => p.name === "github")!.tools;
  return { tools, scope, deps };
}

type Tools = Awaited<ReturnType<typeof githubTools>>["tools"];

const call = (tools: Tools, method: string, args: unknown): Promise<unknown> =>
  (tools[method] as { execute: (a: unknown) => Promise<unknown> }).execute(args);

const validInput = {
  branch: "fix/checkout-timeout",
  title: "fix: stop checkout from timing out",
  commitMessage: "Stop checkout timing out on large carts",
  description: "Checkout timed out for carts above 200 lines; capped the batch size.",
  acceptanceCriteria: [
    "Checkout completes for a 250-line cart",
    "No regression on a small cart",
  ],
  fixesIssueIds: [] as string[],
  partOfIssueIds: [] as string[],
  diffRef: "diff_abc123",
};

/* --------------------------------------------------------- Step 1: the renderer -- */

describe("renderPrBody", () => {
  const base = {
    fixes: [] as Array<{ identifier: string }>,
    partOf: [] as Array<{ identifier: string }>,
    description: "the description paragraph",
    acceptanceCriteria: ["first criterion", "second criterion"],
  };

  it("starts at ## Description, with no leading blank line, when both id lists are empty", () => {
    const body = renderPrBody(base);
    expect(body.startsWith("## Description\n")).toBe(true);
  });

  it("renders Fixes lines first, one per resolved id, then Part of lines, consecutively", () => {
    const body = renderPrBody({
      ...base,
      fixes: [{ identifier: "FIR-12" }, { identifier: "FIR-13" }],
      partOf: [{ identifier: "FIR-7" }],
    });
    expect(body.split("\n").slice(0, 3)).toEqual(["Fixes FIR-12", "Fixes FIR-13", "Part of FIR-7"]);
  });

  it("renders the exact shape end to end — nothing else can appear", () => {
    const body = renderPrBody({
      fixes: [{ identifier: "FIR-12" }, { identifier: "FIR-13" }],
      partOf: [{ identifier: "FIR-7" }],
      description: "the description paragraph",
      acceptanceCriteria: ["first criterion", "second criterion"],
      proofUrl: "https://proof.example/rec.mp4",
      notesForReviewers: "watch the retry path closely",
    });
    expect(body).toBe(
      [
        "Fixes FIR-12",
        "Fixes FIR-13",
        "Part of FIR-7",
        "",
        "## Description",
        "",
        "the description paragraph",
        "",
        "## Acceptance Criteria",
        "",
        "- [ ] first criterion",
        "- [ ] second criterion",
        "",
        "## Screenshots",
        "",
        "https://proof.example/rec.mp4",
        "",
        "## Notes for reviewers",
        "",
        "watch the retry path closely",
      ].join("\n"),
    );
  });

  it("omits ## Screenshots entirely when proofUrl is not given", () => {
    expect(renderPrBody(base)).not.toContain("## Screenshots");
  });

  it("omits ## Notes for reviewers entirely when it is not given", () => {
    expect(renderPrBody(base)).not.toContain("## Notes for reviewers");
  });

  it("renders acceptance criteria as consecutive - [ ] items with no blank line between them", () => {
    const body = renderPrBody({ ...base, acceptanceCriteria: ["a", "b", "c"] });
    const lines = body.split("\n");
    const start = lines.indexOf("- [ ] a");
    expect(lines.slice(start, start + 3)).toEqual(["- [ ] a", "- [ ] b", "- [ ] c"]);
  });

  it("structurally cannot emit a Summary, a Test plan, a footer, or attribution", () => {
    const body = renderPrBody({
      fixes: [{ identifier: "FIR-1" }],
      partOf: [],
      description: "d",
      acceptanceCriteria: ["a"],
      proofUrl: "https://x/y.mp4",
      notesForReviewers: "n",
    });
    expect(body).not.toMatch(/## Summary/i);
    expect(body).not.toMatch(/## Test plan/i);
    expect(body).not.toMatch(/co-authored-by/i);
    expect(body).not.toMatch(/generated with/i);
    expect(body).not.toMatch(/🤖/u);
  });
});

/* --------------------------------------------------------------- Step 2: refusals -- */

describe("attribution refusals — refused, not stripped", () => {
  const tainted: Array<[string, string]> = [
    ["co-authored-by", "Co-Authored-By: Claude <noreply@anthropic.com>"],
    ["generated with", "Generated with Claude Code"],
    ["the robot emoji", "🤖 built this fix"],
    ["the word claude", "Claude wrote this patch"],
  ];

  it.each(tainted)("refuses %s in commitMessage, naming the field and the rule", async (_label, text) => {
    const { tools } = await githubTools();
    const err = (await call(tools, "openPR", { ...validInput, commitMessage: text }).catch(
      (e: unknown) => e,
    )) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/commitMessage/);
    expect(err.message).toMatch(/forbids AI attribution/);
  });

  it.each(tainted)("refuses %s in description", async (_label, text) => {
    const { tools } = await githubTools();
    const err = (await call(tools, "openPR", { ...validInput, description: text }).catch(
      (e: unknown) => e,
    )) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toMatch(/description/);
  });

  it.each(tainted)("refuses %s in notesForReviewers", async (_label, text) => {
    const { tools } = await githubTools();
    const err = (await call(tools, "openPR", { ...validInput, notesForReviewers: text }).catch(
      (e: unknown) => e,
    )) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.message).toMatch(/notesForReviewers/);
  });

  it("never reaches the gateway when a field is tainted — nothing is silently rewritten and sent", async () => {
    let called = false;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          called = true;
          throw new Error("must not be called");
        },
      },
    });
    await call(tools, "openPR", { ...validInput, commitMessage: "Co-Authored-By: Claude" }).catch(
      () => {},
    );
    expect(called).toBe(false);
  });
});

describe("proofUrl refusals", () => {
  it("refuses a non-https proofUrl", async () => {
    const { tools } = await githubTools();
    const err = (await call(tools, "openPR", {
      ...validInput,
      proofUrl: "http://proof.example/rec.mp4",
    }).catch((e: unknown) => e)) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/proofUrl/);
    expect(err.message).toMatch(/https/);
  });

  it("refuses a proofUrl over the 500-character cap", async () => {
    const { tools } = await githubTools();
    const long = `https://proof.example/${"a".repeat(500)}`;
    await expect(call(tools, "openPR", { ...validInput, proofUrl: long })).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("accepts an https proofUrl within the cap", async () => {
    const { tools } = await githubTools();
    await expect(
      call(tools, "openPR", { ...validInput, proofUrl: "https://proof.example/rec.mp4" }),
    ).resolves.toBeDefined();
  });
});

describe("resolveLinkTargets errors surface untouched", () => {
  it("propagates linear_team_denied unreworded", async () => {
    const { tools } = await githubTools({
      linear: {
        resolveLinkTargets: async () => {
          throw new CapabilityError("linear_team_denied", "issue i9 belongs to another team");
        },
      },
    });
    await expect(call(tools, "openPR", { ...validInput, fixesIssueIds: ["i9"] })).rejects.toThrow(
      /linear_team_denied/,
    );
  });

  it("propagates invalid_input for an unknown issue id", async () => {
    const { tools } = await githubTools({
      linear: {
        resolveLinkTargets: async () => {
          throw new CapabilityError("invalid_input", "issue nope was not found");
        },
      },
    });
    await expect(call(tools, "openPR", { ...validInput, partOfIssueIds: ["nope"] })).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("allows both id lists to be empty — a PR may precede its issue", async () => {
    const { tools } = await githubTools();
    await expect(call(tools, "openPR", validInput)).resolves.toBeDefined();
  });

  it("defaults fixesIssueIds and partOfIssueIds to empty when omitted entirely", async () => {
    const { fixesIssueIds, partOfIssueIds, ...rest } = validInput;
    void fixesIssueIds;
    void partOfIssueIds;
    const { tools } = await githubTools();
    await expect(call(tools, "openPR", rest)).resolves.toBeDefined();
  });
});

describe("input schema", () => {
  it.each([
    ["a branch with no type prefix", { branch: "checkout-timeout" }],
    ["a branch with an uppercase word", { branch: "fix/Checkout-Timeout" }],
    ["an oversized branch", { branch: `fix/${"a".repeat(50)}` }],
    ["a title with no colon-space", { title: "fix stop checkout" }],
    ["a title with an unknown conventional type", { title: "improve: stop checkout" }],
    ["an oversized title", { title: `fix: ${"a".repeat(70)}` }],
    ["an empty commitMessage", { commitMessage: "" }],
    ["an empty description", { description: "" }],
    ["no acceptance criteria", { acceptanceCriteria: [] }],
    ["too many acceptance criteria", { acceptanceCriteria: Array.from({ length: 11 }, (_, i) => `c${i}`) }],
    ["too many fixesIssueIds", { fixesIssueIds: Array.from({ length: 6 }, (_, i) => `i${i}`) }],
    ["too many partOfIssueIds", { partOfIssueIds: Array.from({ length: 6 }, (_, i) => `i${i}`) }],
    ["a missing diffRef", { diffRef: undefined }],
    ["an unrecognized field", { extra: "x" }],
  ])("rejects %s", async (_label, patch) => {
    const { tools } = await githubTools();
    await expect(call(tools, "openPR", { ...validInput, ...patch })).rejects.toThrow(/invalid_input/);
  });

  it("rejects a missing number on checkPR", async () => {
    const { tools } = await githubTools();
    await expect(call(tools, "checkPR", {})).rejects.toThrow(/invalid_input/);
  });
});

/* ---------------------------------------------------------------- Step 3: wiring -- */

describe("the github namespace's wiring", () => {
  it("is appended last, after browser, in the frozen namespace order", () => {
    expect(PHASE_09_NAMESPACES[PHASE_09_NAMESPACES.length - 1]).toBe("github");
    expect(PHASE_09_NAMESPACES).toEqual([
      "slack",
      "memory",
      "linear",
      "supabase",
      "langsmith",
      "betterstack",
      "files",
      "approval",
      "sandbox",
      "browser",
      "github",
    ]);
  });

  it("is the last provider the registry builds", async () => {
    const scope = await seedPermittedScope(env.DB);
    const names = buildRegistry(
      scope,
      { ...fakeDeps(), db: env.DB },
      TEST_LIMITS,
      testExecution({ audit: fakeAuditSink() }),
    ).map((p) => p.name);
    expect(names[names.length - 1]).toBe("github");
  });

  it("classifies openPR as external_write and checkPR as read", async () => {
    const { tools } = await githubTools();
    const table: Record<string, string | null> = {};
    for (const [method, tool] of Object.entries(tools)) table[method] = capabilityEffectOf(tool);
    expect(table).toEqual({ openPR: "external_write", checkPR: "read" });
  });

  it("declares exactly openPR and checkPR", async () => {
    const { tools } = await githubTools();
    expect(Object.keys(tools).sort()).toEqual(["checkPR", "openPR"]);
  });
});

describe("openPR's effect key", () => {
  it("does not alias two calls that differ only by branch", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      github: {
        openPR: async (input) => {
          calls += 1;
          return { number: calls, url: `https://x/${calls}`, headRef: input.branch, author: "bot", updated: false };
        },
      },
    });
    await call(tools, "openPR", { ...validInput, branch: "fix/first-branch" });
    await call(tools, "openPR", { ...validInput, branch: "fix/second-branch" });
    expect(calls).toBe(2);
  });

  it("does not alias two calls that differ only by title", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          calls += 1;
          return { number: calls, url: `https://x/${calls}`, headRef: "fix/a", author: "bot", updated: false };
        },
      },
    });
    await call(tools, "openPR", { ...validInput, title: "fix: stop checkout timing out" });
    await call(tools, "openPR", { ...validInput, title: "fix: stop checkout from timing out today" });
    expect(calls).toBe(2);
  });

  it("does not alias two calls that differ only by commitMessage", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          calls += 1;
          return { number: calls, url: `https://x/${calls}`, headRef: "fix/a", author: "bot", updated: false };
        },
      },
    });
    await call(tools, "openPR", { ...validInput, commitMessage: "Cap the batch size" });
    await call(tools, "openPR", { ...validInput, commitMessage: "Cap the batch size at 200" });
    expect(calls).toBe(2);
  });

  it("does not alias two calls that differ only by diffRef", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          calls += 1;
          return { number: calls, url: `https://x/${calls}`, headRef: "fix/a", author: "bot", updated: false };
        },
      },
    });
    await call(tools, "openPR", { ...validInput, diffRef: "diff_one" });
    await call(tools, "openPR", { ...validInput, diffRef: "diff_two" });
    expect(calls).toBe(2);
  });

  it("does not alias two calls whose RENDERED BODY differs because they resolve to different identifiers", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      linear: {
        resolveLinkTargets: async (ids) =>
          ids.map((id) => ({ id, identifier: id === "i1" ? "FIR-1" : "FIR-2" })),
      },
      github: {
        openPR: async () => {
          calls += 1;
          return { number: calls, url: `https://x/${calls}`, headRef: "fix/a", author: "bot", updated: false };
        },
      },
    });
    await call(tools, "openPR", { ...validInput, fixesIssueIds: ["i1"] });
    await call(tools, "openPR", { ...validInput, fixesIssueIds: ["i2"] });
    expect(calls).toBe(2);
  });

  it("replays a genuinely identical call rather than opening a second PR", async () => {
    let calls = 0;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          calls += 1;
          return { number: 1, url: "https://x/1", headRef: "fix/checkout-timeout", author: "bot", updated: false };
        },
      },
    });
    const a = await call(tools, "openPR", validInput);
    const b = await call(tools, "openPR", validInput);
    expect(calls).toBe(1);
    expect(b).toEqual(a);
  });
});

describe("openPR's reconcile", () => {
  it("resolves an in-doubt effect on retry by calling findPR with the branch", async () => {
    let openCalls = 0;
    let findCalledWith: string | undefined;
    const { tools } = await githubTools({
      github: {
        openPR: async () => {
          openCalls += 1;
          throw new Error("upstream 500");
        },
        findPR: async (branch) => {
          findCalledWith = branch;
          return { number: 9, url: "https://x/9", headRef: branch, author: "bot", updated: true };
        },
      },
    });

    // First call: the upstream call fails ambiguously, so the ledger marks it
    // in_doubt and refuses the retry-unsafe path.
    await expect(
      call(tools, "openPR", { ...validInput, branch: "fix/reconcile-me" }),
    ).rejects.toThrow(/effect_in_doubt/);

    // Second, identical call: the ledger sees `in_doubt` and reconciles
    // through findPR rather than calling openPR again.
    const out = await call(tools, "openPR", { ...validInput, branch: "fix/reconcile-me" });
    expect(findCalledWith).toBe("fix/reconcile-me");
    expect(out).toEqual({ number: 9, url: "https://x/9", headRef: "fix/reconcile-me", author: "bot", updated: true });
    expect(openCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------- checkPR -- */

describe("checkPR", () => {
  it("passes the number through and returns the gateway's status untouched", async () => {
    const status: PullRequestStatus = {
      state: "open",
      url: "https://x/1",
      headRef: "fix/a",
      baseRef: "staging",
      linearLinkback: { commented: true, identifiers: ["FIR-1"] },
    };
    let seen: number | undefined;
    const { tools } = await githubTools({
      github: {
        checkPR: async (n) => {
          seen = n;
          return status;
        },
      },
    });
    await expect(call(tools, "checkPR", { number: 1 })).resolves.toEqual(status);
    expect(seen).toBe(1);
  });
});
