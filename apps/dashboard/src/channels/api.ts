/**
 * The channel-registry half of the dashboard's network surface.
 *
 * One read and one write. The read goes through `getJson` from `../lib/api`;
 * the write repeats that module's error discipline locally, the same way
 * `../approvals/api.ts` does, rather than teaching `lib/api` about PATCH.
 */

import { ApiError, getJson } from "../lib/api";

export type ChannelMode = "observe" | "live" | "internal";

/**
 * Where `customerSlug` came from.
 *
 * `derived` means the registrar slugified the Slack channel name when the bot
 * was invited. That is a guess, and the worker refuses to spend a guess as a
 * Supabase tenant key — so this field is the one thing on the row an operator
 * is actually here to resolve.
 */
export type SlugSource = "derived" | "human";

export type Channel = {
  channelId: string;
  name: string;
  customerSlug: string | null;
  mode: ChannelMode;
  slugSource: SlugSource;
};

function kindFor(status: number): ApiError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "unavailable";
}

export async function fetchChannels(): Promise<Channel[]> {
  const body = await getJson<{ channels: Channel[] }>("/api/channels");
  return body.channels;
}

/** What a patch may change. Send one or both; sending neither is a 422. */
export type ChannelPatch = {
  mode?: ChannelMode;
  customerSlug?: string | null;
};

/**
 * Update one channel's policy.
 *
 * Throws `ApiError` on anything that is not a 2xx, INCLUDING the 422 a
 * malformed slug produces — unlike `decide` in the approvals client, there is
 * no status here that is a legitimate answer rather than a failure. A 403 is
 * a viewer trying to write, which the panel already prevents by not rendering
 * the controls; it reaching here at all means something is wrong.
 */
export async function patchChannel(
  channelId: string,
  patch: ChannelPatch
): Promise<Channel> {
  const path = `/api/channels/${encodeURIComponent(channelId)}`;

  let response: Response;
  try {
    response = await fetch(path, {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(patch),
    });
  } catch {
    // Status 0: there was no HTTP response at all.
    throw new ApiError(0, "unavailable", path);
  }

  if (!response.ok) {
    throw new ApiError(response.status, kindFor(response.status), path);
  }

  try {
    return (await response.json()) as Channel;
  } catch {
    throw new ApiError(response.status, "unavailable", path);
  }
}
