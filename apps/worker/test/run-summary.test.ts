import { env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  projectSummary,
  RUN_SUMMARY_LIMIT,
  summaryFrom,
} from "../src/run/agent-projection";
import { installTestModel, resetTestModel } from "../src/run/model";
import { getRunById, setRunSummaryIfAbsent } from "../src/run/repository";
import { createRunFromChat } from "../src/run/wake";
import { cannedModel } from "./helpers/canned-model";
import { waitFor } from "./helpers/wait";

beforeEach(() => installTestModel(cannedModel({ text: "on it" })));
afterEach(() => resetTestModel());

describe("shaping a summary", () => {
  it("keeps a short question exactly as asked", () => {
    expect(summaryFrom("why is the exporter stuck?")).toBe(
      "why is the exporter stuck?"
    );
  });

  it("collapses a pasted stack trace onto one line", () => {
    // A run list is a table. A multi-line summary is one row that is twelve
    // rows tall, which is the thing that makes the list unscannable.
    expect(summaryFrom("line one\n\n  line two\tline three")).toBe(
      "line one line two line three"
    );
  });

  it("bounds a long question with an ellipsis, on a word boundary", () => {
    const summary = summaryFrom(`${"exporter ".repeat(40)}is stuck`);
    expect(summary).not.toBeNull();
    expect((summary as string).length).toBeLessThanOrEqual(RUN_SUMMARY_LIMIT);
    expect(summary).toMatch(/…$/);
    // trimEnd before the ellipsis: "exporter …" is a clipped word wearing a
    // space, and it is the one character a reader notices.
    expect(summary).not.toMatch(/ …$/);
  });

  it("redacts BEFORE it truncates", () => {
    // The ordering is the test. Truncating first can cut a token mid-string,
    // leaving a prefix no pattern matches — a secret laundered past the sweep
    // rather than removed. Invariant 39.
    const asked = `the webhook uses xoxb-${"9".repeat(200)} and it broke`;
    const summary = summaryFrom(asked) as string;
    expect(summary).toContain("[redacted-slack-token]");
    expect(summary).not.toContain("xoxb-");
    expect(summary).not.toMatch(/9{12}/);
    expect(summary.length).toBeLessThanOrEqual(RUN_SUMMARY_LIMIT);
  });

  it("is null when a turn asked nothing, rather than an empty summary", () => {
    // A present-but-empty summary is one the dashboard cannot tell apart from a
    // real one, so it cannot fall back to its "no summary yet" line.
    expect(summaryFrom("")).toBeNull();
    expect(summaryFrom("   \n\t ")).toBeNull();
  });
});

describe("the first summary wins", () => {
  async function runRow() {
    const { runId } = await createRunFromChat(env, {
      firstMessage: "why is the exporter stuck?",
    });
    return runId;
  }

  it("writes once and refuses every write after it", async () => {
    const runId = await runRow();
    await waitFor("the first summary", async () => {
      const run = await getRunById(env.DB, runId);
      return run?.summary ? run : null;
    });

    const second = await setRunSummaryIfAbsent(env.DB, runId, "something else");
    expect(second.applied).toBe(false);

    const run = await getRunById(env.DB, runId);
    expect(run?.summary).toBe("why is the exporter stuck?");
  });

  it("reports a missing row instead of throwing", async () => {
    // The Durable Object owns the session. A lagging index must never be able
    // to fail a customer's answer.
    const outcome = await projectSummary(
      env.DB,
      crypto.randomUUID(),
      "a question about a run that has no index row"
    );
    // Named `run_not_found`, not `summary_present`. A conditional UPDATE
    // reports both as zero rows changed, and collapsing them would hide a real
    // object/index disagreement behind the most ordinary message there is.
    expect(outcome).toEqual({ applied: false, reason: "run_not_found" });
  });

  it("says nothing_asked rather than writing an empty summary", async () => {
    const runId = await runRow();
    expect(await projectSummary(env.DB, runId, "  ")).toEqual({
      applied: false,
      reason: "nothing_asked",
    });
  });
});

describe("a real turn projects its own opening question", () => {
  it("fills the summary the runs list reads, with no model call for it", async () => {
    const { runId } = await createRunFromChat(env, {
      firstMessage: "pulsefit's exporter has been stuck since the 04:12 deploy",
    });

    const run = await waitFor("the projected summary", async () => {
      const found = await getRunById(env.DB, runId);
      return found?.summary ? found : null;
    });

    // The human's words, not the model's. The canned model answers "on it",
    // which is exactly the useless label a model-written summary produces for
    // a run that failed on its first step.
    expect(run.summary).toBe(
      "pulsefit's exporter has been stuck since the 04:12 deploy"
    );
    expect(run.summary).not.toContain("on it");
  });

  it("does not rewrite the summary when the run is steered again", async () => {
    const { runId } = await createRunFromChat(env, {
      firstMessage: "the first thing anyone asked",
    });
    const first = await waitFor("the first summary", async () => {
      const found = await getRunById(env.DB, runId);
      return found?.summary ? found : null;
    });

    // The private key comes from the row, never string-built: `runs.id` is the
    // public id and `runs.key` is what addresses the object (invariant 10).
    const stub = await getAgentByName(env.RUN_AGENTS, first.key);
    await stub.steer("a completely different second question", "req-summary");

    // Wait for EVIDENCE the second turn ran, not for a fixed delay. Polling
    // until the row merely exists would pass without the steer having done
    // anything at all — the assertion below would then be proving nothing.
    // `updated_at` advances on the second turn's status projection.
    const after = await waitFor("the second turn to project", async () => {
      const found = await getRunById(env.DB, runId);
      return found !== null && found.updatedAt > first.updatedAt ? found : null;
    });

    expect(after.summary).toBe("the first thing anyone asked");
    expect(after.summary).not.toContain("second question");
  });
});
