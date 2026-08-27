import type { Roster } from "../api/roster";

/**
 * The roster as `src/access/roster.ts` actually declares it: four
 * fire-fighters in that file's order, three viewers.
 *
 * The connect flags are chosen so the fixture is internally consistent with
 * how `src/identity/speaker.ts` picks — first in `pool` order who has
 * connected. Ronit is first in the pool but has not connected Slack, so Luka
 * speaks; Ronit HAS connected GitHub, so PRs are authored as Ronit. That
 * divergence is real behaviour and worth seeing on screen. Mikheil has
 * connected neither, which is what an unconnected row looks like.
 */
export const demoRoster: Roster = {
  speaker: { email: "luka@zellify.app" },
  githubSpeaker: { email: "ronit@zellify.app" },
  pool: [
    "ronit@zellify.app",
    "luka@zellify.app",
    "mikheil@zellify.app",
    "zurab@zellify.app",
  ],
  engineers: [
    {
      email: "ronit@zellify.app",
      role: "firefighter",
      slack: false,
      github: true,
    },
    {
      email: "luka@zellify.app",
      role: "firefighter",
      slack: true,
      github: true,
    },
    {
      email: "mikheil@zellify.app",
      role: "firefighter",
      slack: false,
      github: false,
    },
    {
      email: "zurab@zellify.app",
      role: "firefighter",
      slack: true,
      github: true,
    },
    {
      email: "marcus@zellify.app",
      role: "viewer",
      slack: false,
      github: false,
    },
    { email: "nils@zellify.app", role: "viewer", slack: false, github: false },
    { email: "eric@zellify.app", role: "viewer", slack: false, github: false },
  ],
};
