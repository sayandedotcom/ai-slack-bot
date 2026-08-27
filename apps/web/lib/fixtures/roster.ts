import type { Roster } from "../api/roster";

/**
 * The roster as `src/access/roster.ts` actually declares it: FIVE fire-fighters
 * in that file's order — the four `@zellify.app` accounts and the personal
 * override tagged `G2-TEMP-OVERRIDE` — then three viewers.
 *
 * The connect flags are not invented either. They reproduce what the deployed
 * Worker's `GET /api/roster` returns today: only `sayandeten@gmail.com` has
 * completed either OAuth flow, so `src/identity/speaker.ts` — first in `pool`
 * order who has connected — resolves BOTH the Slack speaker and the GitHub
 * author to that account, even though it is last in the pool. Everyone above it
 * is skipped for the one reason that matters: nobody connected.
 *
 * That is why this fixture looks lopsided, and why it should stay lopsided.
 * Demo mode is a rehearsal of the live screen, and the live screen currently
 * shows one connected engineer carrying every outbound message. A fixture that
 * spread the connections around would be a nicer picture of a system that does
 * not exist, and the first live run would contradict it.
 *
 * Note what the pool order still buys: it is the evidence that seniority in the
 * roster does NOT decide who speaks. Connection does.
 */
export const demoRoster: Roster = {
  speaker: { email: "sayandeten@gmail.com" },
  githubSpeaker: { email: "sayandeten@gmail.com" },
  pool: [
    "ronit@zellify.app",
    "luka@zellify.app",
    "mikheil@zellify.app",
    "zurab@zellify.app",
    "sayandeten@gmail.com",
  ],
  engineers: [
    {
      email: "ronit@zellify.app",
      role: "firefighter",
      slack: false,
      github: false,
    },
    {
      email: "luka@zellify.app",
      role: "firefighter",
      slack: false,
      github: false,
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
      slack: false,
      github: false,
    },
    // The only connected account, and therefore the only one that can speak.
    {
      email: "sayandeten@gmail.com",
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
