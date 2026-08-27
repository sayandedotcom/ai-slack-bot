import type { Channel, ChannelPatch } from "../api/channels";

/**
 * Demo channels, and like the approvals fixture this one is MUTABLE: the
 * registry is a control surface, and a demo where clicking Confirm changes
 * nothing demonstrates the opposite of the point.
 *
 * The rows are chosen so the two states the panel exists to distinguish are
 * both on screen at once — a customer a human confirmed, and one still
 * carrying the registrar's guess. Plus an internal channel with no customer at
 * all, because that is what a `null` slug looks like and it must not read as a
 * missing value.
 */

const rows: Channel[] = [
  {
    channelId: "C0PULSEFIT",
    name: "zellify-pulsefit",
    customerSlug: "pulsefit",
    mode: "live",
    slugSource: "human",
  },
  {
    channelId: "C0LINGUA",
    name: "zellify-lingua",
    customerSlug: "lingua",
    mode: "live",
    slugSource: "human",
  },
  {
    channelId: "C0DRIFTWEAR",
    name: "zellify-driftwear",
    customerSlug: "zellify-driftwear",
    mode: "observe",
    slugSource: "derived",
  },
  {
    channelId: "C0MACROSNAP",
    name: "zellify-macrosnap",
    customerSlug: "zellify-macrosnap",
    mode: "live",
    slugSource: "derived",
  },
  {
    channelId: "C0ENGINEERING",
    name: "engineering",
    customerSlug: null,
    mode: "internal",
    slugSource: "derived",
  },
];

export function demoChannels(): Channel[] {
  return rows.map((row) => ({ ...row }));
}

/**
 * Mirrors the Worker's write exactly, including the part a client must never
 * predict: setting a slug promotes `slugSource` to `human` in the same step,
 * and clearing it sends the row back to `derived` — nothing is confirmed any
 * more, so the Supabase refusal comes back on. A `mode`-only patch touches
 * neither.
 */
export function patchDemoChannel(
  channelId: string,
  patch: ChannelPatch
): Channel {
  const row = rows.find((candidate) => candidate.channelId === channelId);
  if (row === undefined) throw new Error("no such channel");

  if (patch.mode !== undefined) row.mode = patch.mode;
  if (patch.customerSlug !== undefined) {
    row.customerSlug = patch.customerSlug;
    row.slugSource = patch.customerSlug === null ? "derived" : "human";
  }
  return { ...row };
}
