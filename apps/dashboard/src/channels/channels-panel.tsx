import { Button } from "@workspace/ui/components/button";
import { type ReactNode, useState } from "react";
import { Panel, type PanelState } from "../components/panel";
import type { Role } from "../lib/api";
import { usePoll } from "../lib/use-poll";
import {
  type Channel,
  type ChannelMode,
  type ChannelPatch,
  fetchChannels,
  patchChannel,
} from "./api";

/**
 * The channel registry, and the two things about it only a human can decide.
 *
 * Channels register themselves the moment the bot is invited, which is what
 * makes this a generic bot rather than one with a hand-seeded list. But
 * registration has to guess at two values, and both were previously only
 * correctable by writing SQL against production D1:
 *
 *  - `mode` defaults to `live`, so invite means postable. Right default,
 *    but it needed a way back.
 *  - `customerSlug` is slugified from the Slack channel name. It is fine as a
 *    memory graph id, and it is NOT fine as a Supabase tenant key — the worker
 *    refuses tenant-scoped reads until someone confirms it here.
 *
 * Viewers see the table and no controls. The worker refuses their write
 * anyway (fire-fighters only, checked before D1 is touched); hiding the
 * controls just avoids offering an action that will 403.
 */

const EMPTY_HINT =
  "No channels yet — invite the bot to one and it registers itself, or wait a minute for the cron sweep.";

const MODES: ChannelMode[] = ["observe", "live", "internal"];

/** What each mode actually permits, in the fewest words that are still true. */
const MODE_HINT: Record<ChannelMode, string> = {
  observe: "heard and triaged, never posts",
  live: "heard, triaged, and may post",
  internal: "heard only, no triage",
};

function ModeControl({
  channel,
  disabled,
  onPatch,
}: {
  channel: Channel;
  disabled: boolean;
  onPatch: (patch: ChannelPatch) => void;
}): ReactNode {
  return (
    <div className="flex flex-wrap gap-1">
      {MODES.map((mode) => (
        <Button
          key={mode}
          size="sm"
          variant={channel.mode === mode ? "default" : "outline"}
          disabled={disabled || channel.mode === mode}
          title={MODE_HINT[mode]}
          onClick={() => onPatch({ mode })}
        >
          {mode}
        </Button>
      ))}
    </div>
  );
}

/**
 * The customer cell.
 *
 * A derived slug is shown as unconfirmed rather than hidden: the operator's
 * job here is to look at the guess, decide whether it is right, and say so.
 * Confirming without editing is a real action — it is how a correct guess
 * becomes usable — so the input is pre-filled and submitting it unchanged is
 * exactly the intended path.
 */
function CustomerControl({
  channel,
  editable,
  disabled,
  onPatch,
}: {
  channel: Channel;
  editable: boolean;
  disabled: boolean;
  onPatch: (patch: ChannelPatch) => void;
}): ReactNode {
  const [draft, setDraft] = useState(channel.customerSlug ?? "");
  const confirmed = channel.slugSource === "human";

  const label =
    channel.customerSlug === null ? (
      <span className="text-muted-foreground">no customer</span>
    ) : (
      <span className={confirmed ? "" : "text-muted-foreground"}>
        {channel.customerSlug}
      </span>
    );

  if (!editable) {
    return (
      <div className="space-y-1">
        <p className="text-sm">{label}</p>
        {confirmed || channel.customerSlug === null ? null : (
          <p className="text-muted-foreground text-xs">
            guessed from the channel name — customer data reads are refused
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        const slug = draft.trim();
        onPatch({ customerSlug: slug === "" ? null : slug });
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={disabled}
          aria-label={`customer slug for ${channel.name}`}
          placeholder="no customer"
          className="w-40 rounded border border-border bg-background px-2 py-1 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          {confirmed ? "Update" : "Confirm"}
        </Button>
      </div>
      {confirmed ? (
        <p className="text-muted-foreground text-xs">confirmed</p>
      ) : channel.customerSlug === null ? null : (
        <p className="text-muted-foreground text-xs">
          guessed from the channel name — customer data reads are refused until
          confirmed
        </p>
      )}
    </form>
  );
}

function ChannelRow({
  channel,
  editable,
  pending,
  onPatch,
}: {
  channel: Channel;
  editable: boolean;
  pending: boolean;
  onPatch: (patch: ChannelPatch) => void;
}): ReactNode {
  return (
    <li className="grid grid-cols-1 gap-3 border-border border-b py-3 last:border-b-0 md:grid-cols-3">
      <div className="space-y-1">
        <p className="font-medium text-sm">#{channel.name}</p>
        <p className="font-mono text-muted-foreground text-xs">
          {channel.channelId}
        </p>
      </div>
      <CustomerControl
        channel={channel}
        editable={editable}
        disabled={pending}
        onPatch={onPatch}
      />
      {editable ? (
        <ModeControl channel={channel} disabled={pending} onPatch={onPatch} />
      ) : (
        <p
          className="text-muted-foreground text-sm"
          title={MODE_HINT[channel.mode]}
        >
          {channel.mode}
        </p>
      )}
    </li>
  );
}

export function ChannelsPanel({ role }: { role: Role | null }): ReactNode {
  // 60s rather than the 30s the busier panels use. This table changes when a
  // human invites a bot or clicks a button here, not on its own.
  const state = usePoll(fetchChannels, 60_000);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const editable = role === "firefighter";

  const view: PanelState<Channel[]> =
    state.kind === "ready" && state.data.length === 0
      ? { kind: "empty", hint: EMPTY_HINT }
      : state;

  async function apply(channelId: string, patch: ChannelPatch) {
    setPending(channelId);
    setFailed(null);
    try {
      await patchChannel(channelId, patch);
      // Refetch rather than patch local state: the row that comes back is what
      // D1 now holds, and `slugSource` moves as a consequence of the write
      // rather than as something this component can predict.
      state.refresh();
    } catch {
      // The message deliberately says nothing about the response body — same
      // discipline as `lib/api`, whose errors carry a path and a status only.
      setFailed(channelId);
    } finally {
      setPending(null);
    }
  }

  return (
    <Panel title="Channels" state={view}>
      {(channels) => (
        <ul>
          {[...channels]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((channel) => (
              <div key={channel.channelId}>
                <ChannelRow
                  channel={channel}
                  editable={editable}
                  pending={pending === channel.channelId}
                  onPatch={(patch) => void apply(channel.channelId, patch)}
                />
                {failed === channel.channelId ? (
                  <p role="alert" className="pb-2 text-destructive text-xs">
                    That change did not apply. Check the slug is lowercase
                    letters, digits and dashes, then try again.
                  </p>
                ) : null}
              </div>
            ))}
        </ul>
      )}
    </Panel>
  );
}
