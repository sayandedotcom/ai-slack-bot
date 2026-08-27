"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type Channel,
  type ChannelPatch,
  getChannels,
  patchChannel,
} from "../api/channels";
import type { PanelState } from "../panel-state";
import { POLL_MS, queryKeys } from "../query/keys";
import { toPanelState } from "../query/to-panel-state";

export const EMPTY_CHANNELS_HINT =
  "No channels yet — invite the bot to one and it registers itself, or wait a minute for the cron sweep.";

/**
 * The registry, and the write that corrects it.
 *
 * No optimistic update and no local row state, deliberately. `slugSource` moves
 * as a CONSEQUENCE of the write — confirming a slug promotes it to `human`,
 * clearing it sends it back to `derived` — so the row the Worker returns is the
 * only honest thing to render. The mutation writes that row straight into the
 * cache, which is why the panel does not flash back to the old value while a
 * refetch is in flight.
 *
 * `pendingId` rather than a boolean: two rows can be edited in one sitting and
 * only the one being written should lock.
 */
export function useChannels(): {
  state: PanelState<Channel[]>;
  pendingId: string | null;
  failedId: string | null;
  apply: (channelId: string, patch: ChannelPatch) => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.channels,
    queryFn: getChannels,
    // This table changes when somebody invites a bot or clicks a button here,
    // not on its own — so it polls at the roster's pace, not a run's.
    refetchInterval: POLL_MS.channels,
  });

  const mutation = useMutation({
    mutationFn: ({
      channelId,
      patch,
    }: {
      channelId: string;
      patch: ChannelPatch;
    }) => patchChannel(channelId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData<Channel[]>(queryKeys.channels, (rows) =>
        rows?.map((row) =>
          row.channelId === updated.channelId ? updated : row
        )
      );
    },
  });

  return {
    state: toPanelState(query, {
      emptyHint: EMPTY_CHANNELS_HINT,
      isEmpty: (channels) => channels.length === 0,
    }),
    pendingId: mutation.isPending ? mutation.variables.channelId : null,
    // The message a failure produces says nothing about the response body —
    // same discipline as `lib/api/errors.ts`, whose errors carry a path only.
    failedId: mutation.isError ? mutation.variables.channelId : null,
    apply: (channelId, patch) => mutation.mutate({ channelId, patch }),
  };
}
