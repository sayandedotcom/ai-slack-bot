import type { ReactNode } from "react";

import { fetchShadowPairs, type ShadowPair } from "./api";
import { usePoll } from "../lib/use-poll";
import { Panel, type PanelState } from "../components/panel";

/**
 * The eval corpus this phase exists to build: every draft the agent wrote on
 * an observe-mode channel, next to what the on-duty engineer actually sent in
 * that thread. Self-polling like `RunList` and `CountersPanel` — nothing else
 * on the grid needs this document, so there is no reason to lift the fetch
 * into `App` the way the roster poll is shared between `SpeakerStrip` and
 * `ConnectPanel`.
 *
 * A quiet corpus is the good case, not a failure: no shadow drafts means no
 * denied sends happened yet, so it gets the same empty-state treatment as
 * `CountersPanel`'s all-zero read rather than looking broken.
 */

const EMPTY_HINT =
  "No shadow drafts yet — observe-mode channels fill this as threads happen.";

function TellBadges({ tells }: { tells: ShadowPair["tells"] }): ReactNode {
  if (tells.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">clean — no AI tells detected</p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {tells.map((tell) => (
        <li
          key={tell}
          className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {tell}
        </li>
      ))}
    </ul>
  );
}

function HumanSent({ reply }: { reply: ShadowPair["humanReply"] }): ReactNode {
  if (reply === null) {
    return <p className="text-sm text-muted-foreground">no human reply yet</p>;
  }
  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap text-sm">{reply.text}</p>
      {reply.permalink === null ? null : (
        <a
          href={reply.permalink}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
        >
          view in Slack
        </a>
      )}
    </div>
  );
}

function PairRow({ pair }: { pair: ShadowPair }): ReactNode {
  return (
    <li className="grid grid-cols-1 gap-4 border-b border-border py-3 last:border-b-0 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Agent drafted</p>
        <p className="whitespace-pre-wrap text-sm">{pair.draft}</p>
        <TellBadges tells={pair.tells} />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Human sent</p>
        <HumanSent reply={pair.humanReply} />
      </div>
    </li>
  );
}

export function ShadowPanel(): ReactNode {
  const state = usePoll(fetchShadowPairs, 30_000);

  const view: PanelState<ShadowPair[]> =
    state.kind === "ready" && state.data.length === 0
      ? { kind: "empty", hint: EMPTY_HINT }
      : state;

  return (
    <Panel title="Shadow drafts" state={view}>
      {(pairs) => (
        <ul>
          {/* Newest first, same convention as the approvals queue. */}
          {[...pairs]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((pair) => (
              <PairRow key={pair.approvalId} pair={pair} />
            ))}
        </ul>
      )}
    </Panel>
  );
}
