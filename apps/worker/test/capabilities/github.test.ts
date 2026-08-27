import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { makeGithubTools } from "../../src/capabilities/namespaces/github";
import type { GithubGateway, LinearGateway } from "../../src/gateways/ports";
import { createOrGetRun } from "../../src/run/repository";
import { testBindingContext } from "../helpers/capabilities";

async function actingScope() {
  const run = await createOrGetRun(env.DB, {
    key: `chat:${crypto.randomUUID()}`,
    origin: "chat",
    channelId: null,
    threadTs: null,
  });
  return { runId: run.id, origin: "chat" as const };
}

function github(): GithubGateway {
  return {
    openPR: vi.fn(async () => ({
      number: 7,
      url: "https://github.com/Zellify/web2app-rebuild/pull/7",
      headRef: "fix/copy-id",
      author: "ronit",
      updated: false,
    })),
    findPR: vi.fn(async () => null),
    checkPR: vi.fn(async () => ({
      state: "open" as const,
      url: "u",
      headRef: "h",
      baseRef: "staging",
      linearLinkback: { commented: true, identifiers: ["FF-1"] },
    })),
    searchPRs: vi.fn(async () => []),
  } as unknown as GithubGateway;
}

function linear(): LinearGateway {
  return {
    resolveLinkTargets: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, identifier: "FF-1" }))
    ),
  } as unknown as LinearGateway;
}

const validPR = {
  branch: "fix/copy-id-button",
  title: "fix: copy ID button does nothing",
  commitMessage: "fix: copy ID button does nothing",
  description: "The button never bound its click handler.",
  acceptanceCriteria: ["Clicking the button copies the id"],
  fixesIssueIds: ["FF-1"],
  partOfIssueIds: [],
  diffRef: "diff-abc",
};

describe("github.openPR", () => {
  it("opens a PR and returns where it landed", async () => {
    const scope = await actingScope();
    const gh = github();
    const tools = makeGithubTools(
      testBindingContext({ scope, deps: { github: gh, linear: linear() } })
    );
    const out = await tools.openPR.run(validPR);
    expect(out).toMatchObject({ number: 7, author: "ronit" });
  });

  it("takes no repo or base argument — both are pinned server-side", () => {
    const rendered = JSON.stringify(
      makeGithubTools(testBindingContext()).openPR.input
    );
    expect(rendered).not.toMatch(/"repo"|"baseRef"|"owner"/);
  });

  it("refuses a branch that does not follow the repo's convention", async () => {
    const scope = await actingScope();
    const tools = makeGithubTools(
      testBindingContext({
        scope,
        deps: { github: github(), linear: linear() },
      })
    );
    await expect(
      tools.openPR.run({ ...validPR, branch: "My_Branch" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a title that does not follow the repo's convention", async () => {
    const scope = await actingScope();
    const tools = makeGithubTools(
      testBindingContext({
        scope,
        deps: { github: github(), linear: linear() },
      })
    );
    await expect(
      tools.openPR.run({ ...validPR, title: "copy id button" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses an AI attribution trailer anywhere the human will see it", async () => {
    // The PR opens under a real engineer's GitHub identity. A Co-Authored-By
    // trailer naming a model is exactly the tell this product exists to avoid.
    const scope = await actingScope();
    const gh = github();
    const tools = makeGithubTools(
      testBindingContext({ scope, deps: { github: gh, linear: linear() } })
    );
    await expect(
      tools.openPR.run({
        ...validPR,
        commitMessage:
          "fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      })
    ).rejects.toThrow();
    expect(gh.openPR).not.toHaveBeenCalled();
  });

  it("opens once for two identical calls in one turn", async () => {
    const scope = await actingScope();
    const gh = github();
    const tools = makeGithubTools(
      testBindingContext({ scope, deps: { github: gh, linear: linear() } })
    );
    await tools.openPR.run(validPR);
    await tools.openPR.run(validPR);
    expect(gh.openPR).toHaveBeenCalledTimes(1);
  });

  it("refuses from a run that cannot be confirmed", async () => {
    const gh = github();
    const tools = makeGithubTools(
      testBindingContext({ deps: { github: gh, linear: linear() } })
    );
    await expect(tools.openPR.run(validPR)).rejects.toMatchObject({
      code: "shadow_write_denied",
    });
    expect(gh.openPR).not.toHaveBeenCalled();
  });
});

describe("github reads", () => {
  it("reports whether the Linear linkback landed", async () => {
    const tools = makeGithubTools(
      testBindingContext({ deps: { github: github(), linear: linear() } })
    );
    const out = (await tools.checkPR.run({ number: 7 })) as {
      linearLinkback: { commented: boolean };
    };
    expect(out.linearLinkback.commented).toBe(true);
  });
});
