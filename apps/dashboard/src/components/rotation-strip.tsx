import { Panel, type PanelState } from "./panel";
import type { Roster } from "../lib/api";

/**
 * Who is holding the pager right now, and who takes it next. It is a strip
 * rather than a grid because the rotation is an ordered queue: reading it left
 * to right is the whole point, and a grid would hide that order.
 *
 * The countdown is computed at render time and never ticks — `app.tsx` polls
 * the roster, so a re-render is what keeps this honest. A local timer would
 * only invent precision the data does not have.
 */

/** The local-part is what people call each other; the domain is noise here. */
function nameOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

function initialOf(email: string): string {
  return (email.trim()[0] ?? "?").toUpperCase();
}

const UNTIL = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Whole days and hours left; anything already elapsed reads as "0d 0h". */
function remaining(endMs: number, nowMs: number): string {
  const ms = Math.max(0, endMs - nowMs);
  const hours = Math.floor(ms / 3_600_000);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function RotationStrip({ state }: { state: PanelState<Roster> }) {
  return (
    <Panel title="Rotation" state={state}>
      {({ onDuty, rotation }) => {
        const now = Date.now();
        const upcoming = rotation.filter((email) => email !== onDuty.email);

        return (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-medium text-primary-foreground">
                {initialOf(onDuty.email)}
              </span>
              <span className="font-medium">{nameOf(onDuty.email)}</span>
              <span className="text-muted-foreground">
                until {UNTIL.format(new Date(onDuty.shiftEndMs))}
              </span>
            </div>

            <div className="text-muted-foreground">
              next:{" "}
              <span className="text-foreground">
                {nameOf(onDuty.nextEmail)}
              </span>{" "}
              in {remaining(onDuty.shiftEndMs, now)}
            </div>

            {upcoming.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                {upcoming.map((email, i) => (
                  <span key={email}>
                    {i > 0 ? <span className="mr-2">·</span> : null}
                    {nameOf(email)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        );
      }}
    </Panel>
  );
}
