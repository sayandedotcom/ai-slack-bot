"use client";

import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import { AlertTriangle, Check, Hash, Radio } from "lucide-react";
import { useState } from "react";

import { Panel } from "@/components/common/panel";
import type { Channel, ChannelMode, ChannelPatch } from "@/lib/api/channels";
import type { Role } from "@/lib/api/identity";
import { useChannels } from "@/lib/hooks/use-channels";

/**
 * The channel registry, and the two things about it only a human can decide.
 *
 * Channels register themselves the moment the bot is invited, which is what
 * makes this a generic bot rather than one with a hand-seeded list. But
 * registration has to guess at two values, and until this panel existed both
 * were only correctable by writing SQL against production D1:
 *
 *  - `mode` defaults to `live`, so invite means postable. Right default, but it
 *    needed a way back.
 *  - `customerSlug` is slugified from the Slack channel name. Fine as a memory
 *    graph id, which is ours. NOT fine as a Supabase tenant key — the Worker
 *    refuses tenant-scoped reads until somebody confirms it here.
 *
 * Viewers see the table and no controls. The Worker refuses their write anyway
 * (fire-fighters only, checked before D1 is touched); hiding the controls just
 * avoids offering an action that will 403.
 *
 * A table rather than the SPA's list of rows, because this is tabular and the
 * question a reader arrives with is a COLUMN one — "which of these is still a
 * guess?" — not a row one.
 */

const MODES: ChannelMode[] = ["observe", "live", "internal"];

/** What each mode actually permits, in the fewest words that are still true. */
const MODE_HINT: Record<ChannelMode, string> = {
  observe: "Heard and triaged. The agent never posts here.",
  live: "Heard, triaged, and the agent may post.",
  internal: "Heard only. No triage, no posting.",
};

export function ChannelsPanel({ role }: { role: Role | null }) {
  const { state, pendingId, failedId, apply } = useChannels();
  const editable = role === "firefighter";

  return (
    <Panel
      title="Channels"
      icon={Radio}
      state={state}
      aside={
        <span className="eyebrow">
          {editable ? "they register themselves" : "read-only for viewers"}
        </span>
      }
      description="Where the agent listens, and who each channel belongs to. A channel registers itself when the bot is invited; both of these are guesses until somebody says otherwise."
    >
      {(channels) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Mode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...channels]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((channel) => (
                <ChannelRow
                  key={channel.channelId}
                  channel={channel}
                  editable={editable}
                  pending={pendingId === channel.channelId}
                  failed={failedId === channel.channelId}
                  onPatch={(patch) => apply(channel.channelId, patch)}
                />
              ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function ChannelRow({
  channel,
  editable,
  pending,
  failed,
  onPatch,
}: {
  channel: Channel;
  editable: boolean;
  pending: boolean;
  failed: boolean;
  onPatch: (patch: ChannelPatch) => void;
}) {
  return (
    <>
      <TableRow className={cn(pending && "opacity-60")}>
        <TableCell>
          <span className="flex items-center gap-1.5 font-medium text-sm">
            <Hash className="size-3 text-muted-foreground" aria-hidden="true" />
            {channel.name}
          </span>
          <span className="machine text-[11px] text-muted-foreground">
            {channel.channelId}
          </span>
        </TableCell>

        <TableCell>
          <CustomerCell
            channel={channel}
            editable={editable}
            disabled={pending}
            onPatch={onPatch}
          />
        </TableCell>

        <TableCell className="text-right">
          {editable ? (
            <ModeControl
              channel={channel}
              disabled={pending}
              onPatch={onPatch}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="machine cursor-default text-muted-foreground text-xs" />
                }
              >
                {channel.mode}
              </TooltipTrigger>
              <TooltipContent>{MODE_HINT[channel.mode]}</TooltipContent>
            </Tooltip>
          )}
        </TableCell>
      </TableRow>

      {failed ? (
        <TableRow>
          <TableCell colSpan={3} className="pt-0">
            <p
              role="alert"
              className="flex items-center gap-2 text-destructive text-xs"
            >
              <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
              That change did not apply. A slug is lowercase letters, digits and
              dashes — check it and try again.
            </p>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

/**
 * The customer cell.
 *
 * A derived slug is shown as unconfirmed rather than hidden: the operator's job
 * here is to look at the guess, decide whether it is right, and say so.
 * Confirming WITHOUT editing is a real action — it is how a correct guess
 * becomes usable — so the field is pre-filled and submitting it unchanged is
 * exactly the intended path.
 */
function CustomerCell({
  channel,
  editable,
  disabled,
  onPatch,
}: {
  channel: Channel;
  editable: boolean;
  disabled: boolean;
  onPatch: (patch: ChannelPatch) => void;
}) {
  const [draft, setDraft] = useState(channel.customerSlug ?? "");
  const confirmed = channel.slugSource === "human";

  if (!editable) {
    if (channel.customerSlug === null) {
      return <span className="text-muted-foreground text-sm">no customer</span>;
    }
    return (
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "machine text-xs",
            !confirmed && "text-muted-foreground"
          )}
        >
          {channel.customerSlug}
        </span>
        {confirmed ? (
          <Check className="size-3 text-success" aria-hidden="true" />
        ) : (
          <UnconfirmedMark />
        )}
      </span>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const slug = draft.trim();
        onPatch({ customerSlug: slug === "" ? null : slug });
      }}
    >
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={disabled}
        aria-label={`customer slug for ${channel.name}`}
        placeholder="no customer"
        className="machine h-7 w-36 text-xs"
      />
      <Button type="submit" size="xs" variant="outline" disabled={disabled}>
        {confirmed ? "Update" : "Confirm"}
      </Button>
      {confirmed ? (
        <Check className="size-3 text-success" aria-hidden="true" />
      ) : channel.customerSlug === null ? null : (
        <UnconfirmedMark />
      )}
    </form>
  );
}

/**
 * The whole reason this panel exists, so it says what it costs rather than
 * just marking the row. Warning-toned, not ember: nothing is broken, a read is
 * simply being refused until a human vouches for the name.
 */
function UnconfirmedMark() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex cursor-default items-center text-warning" />
        }
      >
        <AlertTriangle className="size-3" aria-hidden="true" />
        <span className="sr-only">unconfirmed customer</span>
      </TooltipTrigger>
      <TooltipContent>
        Guessed from the channel name. Customer-data reads stay refused until
        somebody confirms it.
      </TooltipContent>
    </Tooltip>
  );
}

function ModeControl({
  channel,
  disabled,
  onPatch,
}: {
  channel: Channel;
  disabled: boolean;
  onPatch: (patch: ChannelPatch) => void;
}) {
  return (
    <div className="inline-flex flex-wrap justify-end gap-1">
      {MODES.map((mode) => {
        const on = channel.mode === mode;
        return (
          <Tooltip key={mode}>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                type="button"
                size="xs"
                // Three states, not two. `default` is the ember fill, and it is
                // reserved for a SELECTED `live` — the only mode that can put
                // words in front of a customer. A selected `observe` or
                // `internal` is still the current choice and still has to read
                // as chosen, so it takes the neutral fill; ember there would
                // spend the one colour this app reserves for consequence.
                variant={
                  on ? (mode === "live" ? "default" : "secondary") : "outline"
                }
                // `aria-pressed`, and NOT `disabled` on the selected one. This
                // is a toggle group: the current mode is the one thing here
                // that must read as chosen, and `disabled:opacity-50` would
                // fade exactly that button until it looked unavailable
                // instead. Only a write in flight disables anything.
                aria-pressed={on}
                disabled={disabled}
                onClick={() => {
                  if (on) return;
                  onPatch({ mode });
                }}
                className="machine"
              >
                {mode}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{MODE_HINT[mode]}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
