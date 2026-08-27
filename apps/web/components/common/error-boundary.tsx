"use client";

import { Button } from "@workspace/ui/components/button";
import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

/**
 * The one class component here, and it exists because React gives no hook
 * equivalent.
 *
 * A throw out of render with nothing above it to catch takes the whole
 * dashboard down to a blank page — during an incident, on the page an operator
 * opened to see the incident. Regions that render text the agent produced are
 * therefore always mounted inside one of these.
 *
 * `resetKey` is what makes the boundary usable rather than terminal: switching
 * runs must clear a failure that belonged to the previous one, or one bad row
 * would poison every row opened afterwards.
 */
type Props = {
  children: ReactNode;
  /** Human sentence shown in place of the children. No stack, no URL. */
  message: string;
  /** Changing this clears the error — pass the run id. */
  resetKey?: string;
  onRetry?: () => void;
};

type State = { failed: boolean; resetKey: string | undefined };

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State
  ): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only, and only in the browser's own devtools: this never reaches
    // a server, a toast, or the copy on screen. Response bodies and URLs can
    // carry things that must not be screenshotted.
    console.error("dashboard render failed", error, info.componentStack);
  }

  private readonly retry = () => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm"
      >
        <p>{this.props.message}</p>
        <Button variant="outline" size="sm" onClick={this.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
