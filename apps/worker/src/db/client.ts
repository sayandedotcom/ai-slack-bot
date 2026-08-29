import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as tables from "./tables";

/**
 * One Drizzle handle per D1 binding, per isolate.
 *
 * Every D1 function in this Worker takes `db: D1Database` as its first
 * argument, and that signature is deliberately unchanged by the move to
 * Drizzle: the conversion happened module by module BEHIND those signatures,
 * so nothing outside `src/db/*.ts` and the per-domain `repository.ts`
 * modules had to know. `orm(db)` is the adapter that makes that possible.
 *
 * The `WeakMap` is not a micro-optimisation, it is what keeps that promise
 * cheap. `drizzle()` builds a session and a dialect object; calling it inside
 * every repository function would rebuild both on every query, several times
 * per request. Keyed on the binding itself, the handle is built once per
 * isolate and released with it — no module-level singleton to leak across
 * tests, and no per-call allocation.
 *
 * The schema is attached so the relational helpers and `db.query.*` are
 * available; today every call site uses the explicit builder.
 */
const handles = new WeakMap<D1Database, DrizzleD1Database<typeof tables>>();

export function orm(db: D1Database): DrizzleD1Database<typeof tables> {
  const existing = handles.get(db);
  if (existing) return existing;
  const created = drizzle(db, { schema: tables });
  handles.set(db, created);
  return created;
}
