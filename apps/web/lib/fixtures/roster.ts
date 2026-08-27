import type { Roster } from "../api/roster";

/**
 * The roster's SHAPE as `src/access/roster.ts` declares it — four fire-fighters
 * in that file's order, then three viewers — with invented people in it.
 *
 * THE NAMES ARE FICTIONAL ON PURPOSE, and must stay that way. Demo mode is what
 * a public Vercel deployment renders, `NEXT_PUBLIC_` constants are inlined into
 * the client bundle at build time, and a fixture is therefore published to
 * anyone who opens the page. This file previously carried the seven real
 * `@zellify.app` addresses, which is how they ended up readable in a JS chunk
 * on a public URL. `example.com` is reserved by IANA and cannot be registered,
 * so nothing here can ever address a mailbox.
 *
 * Structure is preserved exactly, because the structure is what the screen is
 * demonstrating. The connect flags keep the fixture consistent with how
 * `src/identity/speaker.ts` picks — first in `pool` order who has connected.
 * Avery is first in the pool but has not connected Slack, so Blake speaks;
 * Avery HAS connected GitHub, so PRs are authored as Avery. That divergence is
 * real behaviour and worth seeing on screen. Cameron has connected neither,
 * which is what an unconnected row looks like.
 */
export const demoRoster: Roster = {
  speaker: { email: "blake@example.com" },
  githubSpeaker: { email: "avery@example.com" },
  pool: [
    "avery@example.com",
    "blake@example.com",
    "cameron@example.com",
    "devon@example.com",
  ],
  engineers: [
    {
      email: "avery@example.com",
      role: "firefighter",
      slack: false,
      github: true,
    },
    {
      email: "blake@example.com",
      role: "firefighter",
      slack: true,
      github: true,
    },
    {
      email: "cameron@example.com",
      role: "firefighter",
      slack: false,
      github: false,
    },
    {
      email: "devon@example.com",
      role: "firefighter",
      slack: true,
      github: true,
    },
    {
      email: "ellis@example.com",
      role: "viewer",
      slack: false,
      github: false,
    },
    {
      email: "frankie@example.com",
      role: "viewer",
      slack: false,
      github: false,
    },
    { email: "gray@example.com", role: "viewer", slack: false, github: false },
  ],
};
