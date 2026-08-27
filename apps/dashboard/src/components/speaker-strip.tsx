import { Panel, type PanelState } from "./panel";
import type { Roster } from "../lib/api";

/**
 * Whose name goes on what the agent says in public. There is no shift and no
 * countdown (2026-08-17): every fire-fighter on the roster who has connected
 * Slack is eligible, and the strip shows the one who speaks by default — a
 * direct reply, the nudge DM — plus the rest of the pool with their connect
 * state, in tie-break order. An approved reply goes out as whoever clicked
 * approve, when they have connected; that is a property of the click, so it is
 * not on this strip.
 *
 * `app.tsx` polls the roster, so a re-render is what keeps this honest.
 */

/** The local-part is what people call each other; the domain is noise here. */
function nameOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

function initialOf(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

export function SpeakerStrip({ state }: { state: PanelState<Roster> }) {
  return (
    <Panel title="Fire-fighters" state={state}>
      {({ speaker, githubSpeaker, pool, engineers }) => {
        const connected = new Map(engineers.map((e) => [e.email, e] as const));
        const others = pool.filter((email) => email !== speaker?.email);

        return (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
            {speaker === null ? (
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground">
                  ?
                </span>
                <span className="font-medium">nobody can speak</span>
                <span className="text-muted-foreground">
                  no fire-fighter has connected Slack — replies will be blocked
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-medium text-primary-foreground">
                  {initialOf(speaker.email)}
                </span>
                <span className="font-medium">{nameOf(speaker.email)}</span>
                <span className="text-muted-foreground">speaks by default</span>
                {githubSpeaker !== null &&
                githubSpeaker.email !== speaker.email ? (
                  <span className="text-muted-foreground">
                    · PRs as {nameOf(githubSpeaker.email)}
                  </span>
                ) : null}
              </div>
            )}

            {others.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                {others.map((email, i) => {
                  const slack = connected.get(email)?.slack ?? false;
                  return (
                    <span
                      key={email}
                      title={slack ? "connected Slack" : "not connected"}
                    >
                      {i > 0 ? <span className="mr-2">·</span> : null}
                      <span className={slack ? "text-foreground" : undefined}>
                        {nameOf(email)}
                      </span>
                      {slack ? null : (
                        <span className="ml-1 text-xs">(not connected)</span>
                      )}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      }}
    </Panel>
  );
}
