/**
 * The pure index behind the ⌘K command palette.
 *
 * Deliberately not a hook: the palette itself pulls runs and approvals from
 * caches already polled elsewhere (`useRunsPage`, `useApprovals`) and hands
 * the raw rows here, so this function stays testable with no query client, no
 * router and no DOM.
 */
export type PaletteItem = {
  group: "Pages" | "Runs" | "Approvals";
  label: string;
  href: string;
  keywords: string[];
};

const PAGES: PaletteItem[] = [
  {
    group: "Pages",
    label: "Overview",
    href: "/",
    keywords: ["home", "dashboard"],
  },
  { group: "Pages", label: "Runs", href: "/runs", keywords: ["transcript"] },
  {
    group: "Pages",
    label: "Approvals",
    href: "/approvals",
    keywords: ["waiting", "decide"],
  },
  {
    group: "Pages",
    label: "Team",
    href: "/team",
    keywords: ["roster", "speaker"],
  },
  {
    group: "Pages",
    label: "Channels",
    href: "/channels",
    keywords: ["registry"],
  },
  {
    group: "Pages",
    label: "Eval",
    href: "/eval",
    keywords: ["shadow", "triage"],
  },
];

export function paletteItems(input: {
  runs: {
    id: string;
    summary: string | null;
    channelName: string | null;
    status: string;
  }[];
  approvals: { id: string; runId: string; draft: string }[];
}): PaletteItem[] {
  return [
    ...PAGES,
    ...input.runs.map((r) => ({
      group: "Runs" as const,
      label: r.summary ?? `run ${r.id.slice(0, 8)}`,
      href: `/runs/${encodeURIComponent(r.id)}`,
      keywords: [r.id, r.channelName ?? "", r.status].filter(Boolean),
    })),
    ...input.approvals.map((a) => ({
      group: "Approvals" as const,
      label: a.draft.length > 60 ? `${a.draft.slice(0, 60)}…` : a.draft,
      // Not `encodeURIComponent`: a real id is `apr:${uuid}` (see
      // `apps/worker/src/approval/port.ts`), and `:` is a valid, unescaped
      // query-string character (RFC 3986 `pchar`) — encoding it would still
      // work once parsed back through `useSearchParams`, but it would not
      // match the id as written, which is the shape a person copies out of
      // this list.
      href: `/approvals?approval=${a.id}`,
      keywords: [a.id, a.runId],
    })),
  ];
}
