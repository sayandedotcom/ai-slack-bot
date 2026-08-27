import { describe, expect, it } from "vitest";
import {
  buildTriagePrompt,
  TRIAGE_SYSTEM,
  type TriageInput,
} from "../../src/triage/prompt";

const base: TriageInput = {
  channelName: "ext-pulsefit",
  customerSlug: "pulsefit",
  message: {
    user_id: "U1",
    text: "how do I add a second language variant?",
    permalink: "https://x/p1",
  },
  thread: [{ user_id: "U2", text: "earlier context" }],
  recall: [
    {
      factId: "f1",
      fact: "PulseFit complained about checkout in June",
      episodeUuids: ["ep1"],
    },
  ],
};

describe("buildTriagePrompt", () => {
  it("includes the message, thread, and recall facts", () => {
    const p = buildTriagePrompt(base);
    expect(p).toContain("how do I add a second language variant?");
    expect(p).toContain("earlier context");
    expect(p).toContain("PulseFit complained about checkout in June");
    expect(p).toContain("ext-pulsefit");
  });

  it("renders cleanly with no thread and no recall", () => {
    const p = buildTriagePrompt({ ...base, thread: [], recall: [] });
    expect(p).toContain("(no earlier messages in this thread)");
    expect(p).toContain("(no stored context for this customer)");
  });

  /**
   * Observed live, 2026-08-16 (#test-firedrill): "Do you support stripe?" —
   * twice, as fresh top-level messages — triaged wake=0 with "obvious answer,
   * doesn't require action — Stripe is explicitly listed as supported". Recall
   * had handed the model the answer, and it read that as nobody needing to
   * reply. The customer got silence. Knowing the answer is not the same as the
   * customer having received it; the prompt has to say so, because the better
   * memory gets, the more direct questions this drops.
   */
  it("says a direct question wakes even when the answer is already known", () => {
    expect(TRIAGE_SYSTEM).toContain(
      "Knowing the answer is not the same as the customer having received it"
    );
    expect(TRIAGE_SYSTEM).toContain(
      "even when the answer is obvious or already known to us"
    );
  });

  it("never mentions ticket types in the system prompt", () => {
    for (const banned of [
      "bug report",
      "feature request",
      "ticket type",
      "categor",
    ]) {
      expect(TRIAGE_SYSTEM.toLowerCase()).not.toContain(banned);
    }
  });
});
