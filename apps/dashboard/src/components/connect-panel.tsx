import { buttonVariants } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";

import type { ConnectStatus, Identity, Roster } from "../lib/api";
import { Panel, type PanelState } from "./panel";

/**
 * Who has linked Slack and GitHub. The OAuth handshake is started by a plain
 * anchor, not a fetch: the browser already carries the Access cookie, and a
 * top-level navigation is the only thing an OAuth redirect can follow. Only the
 * signed-in engineer's own row is actionable — a token minted from someone
 * else's click would be bound to the wrong identity.
 */

/** Slack and GitHub both hang off the same relative start route shape. */
const START = {
  slack: "/api/oauth/slack/start",
  github: "/api/oauth/github/start",
} as const;

type Provider = keyof typeof START;

function ProviderCell({
  provider,
  engineer,
  isSelf,
}: {
  provider: Provider;
  engineer: ConnectStatus;
  isSelf: boolean;
}) {
  // Viewers never act on an incident, so there is nothing for them to connect.
  if (engineer.role === "viewer") {
    return <span className="text-muted-foreground">—</span>;
  }

  if (engineer[provider]) {
    return (
      <span className="inline-flex items-center gap-1 text-green-500">
        <span aria-hidden="true">✓</span>
        connected
      </span>
    );
  }

  const classes = cn(buttonVariants({ variant: "outline", size: "xs" }));

  if (!isSelf) {
    return (
      <span
        className={cn(classes, "cursor-not-allowed opacity-50")}
        aria-disabled="true"
        title="each engineer connects their own account"
      >
        Connect
      </span>
    );
  }

  return (
    <a className={classes} href={START[provider]}>
      Connect
    </a>
  );
}

export function ConnectPanel({
  state,
  identity,
}: {
  state: PanelState<Roster>;
  identity?: Identity;
}) {
  return (
    <Panel title="Connections" state={state}>
      {(roster) => (
        <ul className="divide-y divide-border text-sm">
          {roster.engineers.map((engineer) => {
            const isSelf = engineer.email === identity?.email;
            return (
              <li
                key={engineer.email}
                className={cn(
                  "flex items-center gap-3 py-2",
                  isSelf &&
                    "-mx-4 border-l-2 border-l-primary bg-accent/40 px-4"
                )}
              >
                <span className="truncate">{engineer.email}</span>
                <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground text-xs">
                  {engineer.role}
                </span>
                <span className="ml-auto flex items-center gap-4 text-xs">
                  <span className="flex w-28 items-center justify-end gap-1.5">
                    <span className="text-muted-foreground">Slack</span>
                    <ProviderCell
                      provider="slack"
                      engineer={engineer}
                      isSelf={isSelf}
                    />
                  </span>
                  <span className="flex w-28 items-center justify-end gap-1.5">
                    <span className="text-muted-foreground">GitHub</span>
                    <ProviderCell
                      provider="github"
                      engineer={engineer}
                      isSelf={isSelf}
                    />
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
