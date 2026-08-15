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
 * STAND-IN SCHEMA, deliberately and currently accurately.
 *
 * The Supabase project Zellify handed over has no tables in its public schema
 * (every probe 404s, re-verified 2026-08-16), so this names the small
 * web2app-shaped schema seeded by `scripts/supabase-seed.sql` into a project
 * we control. The two must move together: a column named here that the seed
 * does not create is a 400 at read time, and a column the seed creates but is
 * not named here is invisible to the model — which is the point.
 *
 * When Zellify points us at the real prod project, replace these entries with
 * the real tables — naming only the columns a responder actually needs. Never
 * add a column holding secrets, tokens, password hashes, or full payment
 * instruments; there is no denylist that catches those later.
 *
 * `customer_slug` is the tenant column everywhere: the reader injects it from
 * the run's channel and a model filter on it is dropped, so a run in one
 * customer's channel can never read another customer's rows.
 */
export const PRODUCTION_ALLOWLIST: SupabaseAllowlist = [
  {
    resource: "accounts",
    columns: [
      { name: "id", type: "uuid" },
      { name: "company", type: "text" },
      { name: "plan", type: "text" },
      { name: "status", type: "text" },
      { name: "created_at", type: "timestamptz" },
    ],
    tenantColumn: "customer_slug",
  },
  {
    resource: "apps",
    columns: [
      { name: "id", type: "uuid" },
      { name: "name", type: "text" },
      { name: "platform", type: "text" },
      { name: "bundle_id", type: "text" },
      { name: "status", type: "text" },
      { name: "store_status", type: "text" },
      { name: "updated_at", type: "timestamptz" },
    ],
    tenantColumn: "customer_slug",
  },
  {
    resource: "builds",
    columns: [
      { name: "id", type: "uuid" },
      { name: "app_id", type: "uuid" },
      { name: "version", type: "text" },
      { name: "platform", type: "text" },
      { name: "status", type: "text" },
      { name: "error", type: "text" },
      { name: "started_at", type: "timestamptz" },
      { name: "finished_at", type: "timestamptz" },
    ],
    tenantColumn: "customer_slug",
  },
];

export function findResource(
  allowlist: SupabaseAllowlist,
  resource: string,
): AllowedResource | null {
  return allowlist.find((entry) => entry.resource === resource) ?? null;
}
