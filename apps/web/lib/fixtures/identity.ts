import type { Identity } from "../api/identity";

/**
 * Demo mode signs you in as a fire-fighter, because the roles differ in what
 * they can do and the interesting half is the one that can act. A viewer's
 * read-only rendering is exercised by the tests, not by the fixture.
 */
export const demoIdentity: Identity = {
  email: "blake@example.com",
  role: "firefighter",
};
