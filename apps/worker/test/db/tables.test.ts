import { env } from "cloudflare:test";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as tables from "../../src/db/tables";

/**
 * The Drizzle definitions in `src/db/tables.ts` describe tables they did not
 * create: `migrations/*.sql` is the source of truth and `drizzle-kit` is
 * deliberately not installed. That buys append-only, hand-commented migrations
 * at the price of one real risk — the two descriptions drifting apart — and
 * this file is what stops that being a matter of discipline.
 *
 * The test database here is built by applying the real migrations
 * (`test/setup.ts` runs `applyD1Migrations`), so `PRAGMA table_info` is
 * literally what the migrations produced. Every assertion below compares that
 * against `getTableConfig`, Drizzle's own view of its schema.
 *
 * What it catches, in the order it will actually happen: a new migration whose
 * columns nobody added here, a column added here that no migration creates, a
 * renamed column, a changed type, a NOT NULL added or dropped, and a default
 * that disagrees. What it deliberately does NOT check is indexes, foreign keys
 * and CHECK constraints: those are not declared in `tables.ts` at all — they
 * are DDL, they live in the migrations, and the query builder never consults
 * them.
 */

type PragmaColumn = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

async function pragma(table: string): Promise<PragmaColumn[]> {
  const { results } = await env.DB.prepare(
    `PRAGMA table_info(${table})`
  ).all<PragmaColumn>();
  return results ?? [];
}

/**
 * Every table in the Drizzle schema, keyed by the export name so a failure
 * names the binding a developer would go and edit. Built by filtering the
 * module's exports rather than by listing them, so a table added to
 * `tables.ts` is covered without anyone remembering to register it here.
 */
const ALL: Array<[string, SQLiteTable]> = Object.entries(tables).map(
  ([exportName, table]) => [exportName, table as SQLiteTable]
);

describe("drizzle schema matches the migrations", () => {
  it("covers every table the migrations create", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '_cf_%'
          AND name NOT LIKE 'd1_%'
        ORDER BY name`
    ).all<{ name: string }>();

    const inDatabase = (results ?? []).map((row) => row.name).sort();
    const inSchema = ALL.map(([, table]) => getTableConfig(table).name).sort();

    // Both directions on purpose: the left-hand miss is a migration nobody
    // modelled, the right-hand one is a table that no longer exists.
    expect(inSchema).toEqual(inDatabase);
  });

  for (const [exportName, table] of ALL) {
    const config = getTableConfig(table);

    describe(`${exportName} (${config.name})`, () => {
      it("declares the same columns, in the same order", async () => {
        const actual = (await pragma(config.name)).map((c) => c.name);
        const declared = config.columns.map((c) => c.name);
        expect(declared).toEqual(actual);
      });

      it("agrees on type, nullability and defaults", async () => {
        const actual = await pragma(config.name);
        const byName = new Map(actual.map((c) => [c.name, c]));

        for (const column of config.columns) {
          const real = byName.get(column.name);
          expect(
            real,
            `${config.name}.${column.name} is missing`
          ).toBeDefined();
          if (!real) continue;

          // SQLite reports the declared type verbatim; Drizzle renders its own.
          // Both sides are upper-cased because the migrations write `TEXT` and
          // `INTEGER` while Drizzle's `getSQLType()` returns lower case.
          expect(
            column.getSQLType().toUpperCase(),
            `${config.name}.${column.name} type`
          ).toBe(real.type.toUpperCase());

          // A PRIMARY KEY column is NOT NULL in effect but SQLite reports
          // `notnull = 0` for a single-column INTEGER/TEXT primary key, so the
          // primary-key case is compared on the primary-key flag instead.
          if (real.pk === 0) {
            expect(
              column.notNull,
              `${config.name}.${column.name} NOT NULL`
            ).toBe(real.notnull === 1);
          } else {
            expect(
              column.primary || config.primaryKeys.length > 0,
              `${config.name}.${column.name} is a primary key in the database`
            ).toBe(true);
          }

          expect(
            column.hasDefault,
            `${config.name}.${column.name} default presence`
          ).toBe(real.dflt_value !== null);

          if (real.dflt_value !== null) {
            // The migrations write `0` and `'derived'`; Drizzle holds `0` and
            // `"derived"`. Compare on the unquoted literal.
            const fromDatabase = real.dflt_value.replace(/^'(.*)'$/, "$1");
            expect(
              String(column.default),
              `${config.name}.${column.name} default value`
            ).toBe(fromDatabase);
          }
        }
      });
    });
  }
});
