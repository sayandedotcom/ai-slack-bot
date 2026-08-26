import { fixture, getJson, isDemo } from "./client";
import { demoIdentity } from "../fixtures/identity";

export type Role = "firefighter" | "viewer";

export type Identity = {
  email: string;
  role: Role;
};

/**
 * Who Access says you are. Fetched once per load and never polled: identity
 * does not change while the tab is open, because Access decides it before the
 * bundle is served.
 */
export function getIdentity(): Promise<Identity> {
  if (isDemo()) return fixture(demoIdentity);
  return getJson<Identity>("/api/identity");
}
