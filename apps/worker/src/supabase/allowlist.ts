/**
 * What the agent may read out of the product database.
 *
 * A reviewed constant rather than runtime introspection, for two reasons that
 * both happen to be true here:
 *
 *  - PostgREST's schema endpoint refuses a publishable key outright ("Only
 *    secret API keys can be used for this endpoint", verified 2026-08-12), so
 *    introspection would mean holding the secret key — the one that bypasses
 *    row-level security entirely;
 *  - a credential being *able* to see a table is not a reason to show it to a
 *    model. The allowlist is the review artefact: adding a resource is a diff
 *    somebody signs off, not a config value that drifts.
 *
 * `tenantColumn` is what makes a read customer-scoped. When it is set, the
 * predicate is injected server-side on every query and cannot be removed or
 * contradicted by a model filter.
 */
export type AllowedResource = {
  resource: string;
  columns: Array<{ name: string; type: string }>;
  /** Column holding the customer key, or null for genuinely global data. */
  tenantColumn: string | null;
};

export type SupabaseAllowlist = readonly AllowedResource[];

/**
 * EMPTY, deliberately and currently accurately.
 *
 * The Supabase project behind `SUPABASE_URL` has no tables in its public schema
 * as of 2026-08-12 — every probe returns 404. An allowlist naming tables that
 * do not exist would be a lie that typechecks, so this stays empty until the
 * product schema exists.
 *
 * Consequence while empty: `supabase.schema()` returns `[]` and every
 * `supabase.select()` is refused with `invalid_input`. That is the correct
 * fail-closed behaviour, not a bug — but it does mean this capability answers
 * nothing useful until real resources are added here.
 *
 * To add one, append an entry naming only the columns a responder actually
 * needs. Never add a column holding secrets, tokens, password hashes, or
 * full payment instruments; there is no denylist that catches those later.
 */
export const PRODUCTION_ALLOWLIST: SupabaseAllowlist = [];

export function findResource(
  allowlist: SupabaseAllowlist,
  resource: string,
): AllowedResource | null {
  return allowlist.find((entry) => entry.resource === resource) ?? null;
}
