import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RunView, type RunViewProps } from "@/components/run/run-view";

/**
 * `RunView` is pure so that every state it can be in is assertable without a
 * socket. The states that matter are the dishonest ones: a dropped connection
 * still showing the last transcript is lying to whoever is steering an
 * incident, and a composer that accepts text it will drop is worse than no
 * composer.
 */

function view(overrides: Partial<RunViewProps> = {}) {
  const props: RunViewProps = {
    connection: "live",
    connectionError: false,
    messages: [
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "Working on it." }],
      },
    ],
    busy: false,
    turnError: false,
    sendError: null,
    onSend: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<RunView {...props} />) };
}

describe("RunView", () => {
  it("says nothing about the connection while it is healthy", () => {
    view();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("distinguishes a first connect from a reconnect", () => {
    const first = view({ connection: "connecting" });
    expect(screen.getByRole("status")).toHaveTextContent(
      /Connecting to the run/
    );
    first.unmount();

    view({ connection: "reconnecting" });
    expect(screen.getByRole("status")).toHaveTextContent(/stale view/);
  });

  it("shows the refusal alone, not stacked under a reconnect banner", () => {
    view({ connection: "connecting", connectionError: true });
    expect(screen.getByRole("alert")).toHaveTextContent(/socket was refused/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("sends a steer and clears the box", async () => {
    const { props } = view();
    const box = screen.getByLabelText("Steer the agent");

    await userEvent.type(box, "check the trace first");
    await userEvent.click(screen.getByLabelText("Steer"));

    expect(props.onSend).toHaveBeenCalledWith("check the trace first");
    expect(box).toHaveValue("");
  });

  it("sends on Enter and keeps a newline on Shift+Enter", async () => {
    const { props } = view();
    const box = screen.getByLabelText("Steer the agent");

    await userEvent.type(box, "one{Shift>}{Enter}{/Shift}two");
    expect(props.onSend).not.toHaveBeenCalled();

    await userEvent.type(box, "{Enter}");
    expect(props.onSend).toHaveBeenCalledWith("one\ntwo");
  });

  it("will not send when the composer is off, whatever is typed", async () => {
    const { props } = view({
      steerDisabledReason: "no run behind this transcript",
    });
    const box = screen.getByLabelText("Steer the agent");

    expect(box).toBeDisabled();
    await userEvent.type(box, "hello");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("offers a way out of a turn error", async () => {
    const { props } = view({ turnError: true });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissError).toHaveBeenCalled();
  });

  it("says the transcript is empty rather than looking broken", () => {
    view({ messages: [] });
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it("does not claim emptiness while the agent is working", () => {
    view({ messages: [], busy: true });
    expect(screen.queryByText(/Nothing yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Working/);
  });
});
