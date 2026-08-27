import type { Identity } from "../api/identity";

/**
 * Demo mode signs you in as the account that actually drives this system.
 *
 * `sayandeten@gmail.com` is a real fire-fighter in `src/access/roster.ts` (the
 * `G2-TEMP-OVERRIDE` entry) and the only one with both OAuth flows completed,
 * so it is what a live `GET /api/identity` returns against the deployed Worker
 * — verified, not assumed. Demo and live therefore open on the same person, and
 * switching `NEXT_PUBLIC_DEMO` off does not change who you appear to be.
 *
 * Fire-fighter rather than viewer, because the roles differ in what they can do
 * and the interesting half is the one that can act — deciding an approval and
 * writing channel policy are both fire-fighters-only. A viewer's read-only
 * rendering is exercised by the tests, not by the fixture.
 */
export const demoIdentity: Identity = {
  email: "sayandeten@gmail.com",
  role: "firefighter",
};
