import { demoChannels, patchDemoChannel } from "../fixtures/channels";
import { fixture, getJson, isDemo, patchJson } from "./client";
import { ApiError, kindFor } from "./errors";

/**
 * The channel registry.
 *
 * Channels register themselves the moment the bot is invited
 * (`apps/worker/src/channels/registry.ts`), which is what makes this a generic
 * bot rather than one with a hand-seeded table. Registration has to GUESS at
 * two values, and this module is how a human corrects both.
 */

export type ChannelMode = "observe" | "live" | "internal";

/**
 * Where `customerSlug` came from.
 *
 * `derived` means the registrar slugified the Slack channel name when the bot
 * was invited. That is a guess, and the Worker refuses to spend a guess as a
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

/** What a patch may change. Send one or both; sending neither is a 422. */
export type ChannelPatch = {
  mode?: ChannelMode;
  customerSlug?: string | null;
};

export async function getChannels(): Promise<Channel[]> {
  if (isDemo()) return fixture(demoChannels());
  const body = await getJson<{ channels: Channel[] }>("/api/channels");
  return body.channels;
}

/**
 * Update one channel's policy, returning the row the Worker now holds.
 *
 * THROWS on anything that is not a 2xx, including the 422 a malformed slug
 * produces — and that is the difference from `decide` in `approvals.ts`, which
 * resolves on a 409 because "somebody else decided first" is an answer the UI
 * has to render. There is no status here that is a legitimate answer rather
 * than a failure: a 403 is a viewer trying to write, which the panel already
 * prevents by not rendering the controls, so reaching one means something is
 * wrong.
 *
 * The returned row is used rather than the request echoed back, because
 * `slugSource` moves as a CONSEQUENCE of the write — setting a slug promotes it
 * to `human`, clearing it sends it back to `derived` — and that is the Worker's
 * decision to report, not this client's to predict.
 */
export async function patchChannel(
  channelId: string,
  patch: ChannelPatch
): Promise<Channel> {
  const path = `/api/channels/${encodeURIComponent(channelId)}`;
  if (isDemo()) return fixture(patchDemoChannel(channelId, patch));

  const { status, body } = await patchJson(path, patch);
  if (status < 200 || status >= 300) {
    throw new ApiError(status, kindFor(status), path);
  }
  return body as Channel;
}
