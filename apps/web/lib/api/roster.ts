import { demoRoster } from "../fixtures/roster";
import { fixture, getJson, isDemo } from "./client";
import type { Role } from "./identity";

export type ConnectStatus = {
  email: string;
  role: Role;
  slack: boolean;
  github: boolean;
};

/**
 * There is no shift and no clock (removed 2026-08-17). Every fire-fighter on
 * the roster who has connected Slack is eligible; `speaker` is the one a direct
 * reply and the nudge DM go out as — first in `pool` order who has connected —
 * or null when nobody has, in which case every customer-facing write refuses.
 * `githubSpeaker` is the same question for the PR author.
 *
 * Nothing here carries a shift, a countdown or a schedule. Do not render one.
 */
export type Roster = {
  speaker: { email: string } | null;
  githubSpeaker: { email: string } | null;
  pool: string[];
  engineers: ConnectStatus[];
};

export function getRoster(): Promise<Roster> {
  if (isDemo()) return fixture(demoRoster);
  return getJson<Roster>("/api/roster");
}

/** Slack and GitHub both hang off the same relative start route shape. */
export const OAUTH_START = {
  slack: "/api/oauth/slack/start",
  github: "/api/oauth/github/start",
} as const;

export type Provider = keyof typeof OAUTH_START;
