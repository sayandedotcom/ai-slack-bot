import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PAYLOAD_MAX_CHARS, Transcript } from "@/components/run/transcript";
import {
  DEMO_CHAT_RUN_ID,
  demoTranscriptFor,
} from "@/lib/fixtures/run-transcript";

/**
 * The transcript takes its parts as `unknown` and narrows them itself, because
 * the live union comes from the AI SDK and changes with it. These cases pin
 * that the narrowing is defensive in the direction that matters: an
 * unrecognised part is DROPPED, never thrown on, because this component renders
 * during an incident.
 */

describe("Transcript", () => {
  it("renders the demo fixture, which is in the socket's own shape", () => {
    render(<Transcript messages={demoTranscriptFor(DEMO_CHAT_RUN_ID)} />);
    expect(
      screen.getByText(/did PulseFit complain about checkout/)
    ).toBeInTheDocument();
    expect(screen.getAllByText("run_code")).toHaveLength(2);
  });

  it("keeps a tool call collapsed until it is asked for", async () => {
    render(<Transcript messages={demoTranscriptFor(DEMO_CHAT_RUN_ID)} />);
    const rows = screen.getAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(2);

    await userEvent.click(rows[0]!);
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText(/memory\.search/)).toBeInTheDocument();
  });

  it("clips an unbounded payload and says that it did", async () => {
    render(
      <Transcript
        messages={[
          {
            id: "m1",
            role: "assistant",
            parts: [
              {
                type: "tool-run_code",
                state: "output-available",
                input: { code: "return 1;" },
                output: "x".repeat(PAYLOAD_MAX_CHARS + 500),
              },
            ],
          },
        ]}
      />
    );

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/truncated at/)).toBeInTheDocument();
  });

  it("drops a part it does not understand rather than throwing", () => {
    render(
      <Transcript
        messages={[
          {
            id: "m1",
            role: "assistant",
            // `reasoning` arrives with an empty text field (invariant 17), and
            // `step-start` carries nothing to draw. Neither may take the page
            // down, and neither may render an empty row.
            parts: [
              { type: "reasoning", text: "" },
              { type: "step-start" },
              null,
              { type: "text", text: "Here is the answer." },
            ],
          },
        ]}
      />
    );

    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing at all for a message with no drawable part", () => {
    const { container } = render(
      <Transcript
        messages={[
          { id: "m1", role: "assistant", parts: [{ type: "step-start" }] },
        ]}
      />
    );
    expect(container.querySelector("li")?.textContent).toBe("");
  });
});
