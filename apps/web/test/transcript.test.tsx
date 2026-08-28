import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  PAYLOAD_MAX_CHARS,
  speakerOf,
  Transcript,
  type TranscriptMessage,
} from "@/components/run/transcript";
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
    // No `chips` prop: every tool row falls back to the tool name plus the
    // length of the code it ran.
    expect(screen.getAllByText(/^run_code · \d+ chars$/)).toHaveLength(2);
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

  it("shows a capability chip strip on the tool row that follows a user turn", () => {
    const messages = [
      {
        id: "turn:1",
        role: "user",
        parts: [{ type: "text", text: "fix it" }],
        metadata: { turnId: "turn:1" },
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_code",
            state: "output-available",
            input: { code: "1" },
            output: "ok",
          },
        ],
      },
    ];
    render(
      <Transcript
        messages={messages}
        chips={new Map([["turn:1", ["slack.post", "supabase.read ×3"]]])}
      />
    );
    expect(screen.getByText("slack.post")).toBeInTheDocument();
    expect(screen.getByText("supabase.read ×3")).toBeInTheDocument();
  });

  it("falls back to the code length when no effects match the turn", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-run_code",
            state: "output-available",
            input: { code: "abcdef" },
            output: "ok",
          },
        ],
      },
    ];
    render(<Transcript messages={messages} chips={new Map()} />);
    expect(screen.getByText("run_code · 6 chars")).toBeInTheDocument();
  });
});

/**
 * Who a row is attributed to is a claim about who said something, and on this
 * product that claim matters: a Slack run's `user` message is the CUSTOMER's,
 * not the operator's, and the agent's reply is a draft nobody has approved yet.
 */
describe("speakerOf", () => {
  const msg = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
    id: "m1",
    role: "user",
    parts: [],
    ...over,
  });

  it("names the customer, not the operator, on a slack-woken run", () => {
    expect(speakerOf(msg({}), "slack")).toBe("Customer");
  });

  it("names the operator on a chat run, where the user really is you", () => {
    expect(speakerOf(msg({}), "chat")).toBe("You");
  });

  it("names the operator for a steer, whichever origin it lands in", () => {
    // The Worker mints a steer's id as `steer:{requestId}`, which is the only
    // thing separating operator input from a thread message the run absorbed.
    expect(speakerOf(msg({ id: "steer:abc" }), "slack")).toBe("You");
    expect(speakerOf(msg({ id: "steer:abc" }), "chat")).toBe("You");
  });

  it("never calls the agent's draft yours — it is unapproved until you say so", () => {
    expect(speakerOf(msg({ role: "assistant" }), "slack")).toBe("Fire-Fighter");
    expect(speakerOf(msg({ role: "assistant" }), "chat")).toBe("Fire-Fighter");
  });

  it("falls back to You when the origin is not yet known", () => {
    // The header read can still be in flight. `chat` is the safer default:
    // it is the only origin where the reader did type the message.
    expect(speakerOf(msg({}), undefined)).toBe("You");
  });
});
