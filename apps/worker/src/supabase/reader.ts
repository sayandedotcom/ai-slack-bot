import { CapabilityError } from "../gateways/errors";
import type {
  ResourceDescription,
  Row,
  SupabaseReader,
} from "../gateways/ports";
import type { RunScope } from "../gateways/scope";
import { findResource, type SupabaseAllowlist } from "./allowlist";

/** PostgREST operator names, keyed by the operators the schema advertises. */
const OPERATORS: Record<string, string> = {
  eq: "eq",
  neq: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  in: "in",
  is: "is",
  like: "like",
};

const MAX_ROWS = 200;

export type SupabaseConfig = {
  /** Fixed origin. Never a parameter — a redirectable origin is an exfil path. */
  url: string;
  /**
   * The PUBLISHABLE key, not the secret one. Read-only is enforced twice: by
   * this reader exposing no write method, and by row-level security in the
   * database. Only the publishable key is subject to the second one, which is
   * the only credential-level backstop any vendor in this phase offers.
   */
  key: string;
  allowlist: SupabaseAllowlist;
};

function invalid(reason: string): CapabilityError {
  return new CapabilityError("invalid_input", reason);
}

/**
 * Render one filter value for PostgREST.
 *
 * Values are encoded, never interpolated. `in` takes a parenthesised list and
 * `is` takes only the three logical constants — accepting anything else there
 * would let a value become a predicate.
 */
function encodeValue(op: string, value: unknown): string {
  if (op === "in") {
    if (!Array.isArray(value)) {
      throw invalid("the 'in' operator needs a list of values.");
    }
    return `(${value.map((v) => String(v)).join(",")})`;
  }
  if (op === "is") {
    if (value !== null && value !== true && value !== false) {
      throw invalid("the 'is' operator accepts only null, true, or false.");
    }
    return value === null ? "null" : String(value);
  }
  if (Array.isArray(value)) {
    throw invalid(`the '${op}' operator takes a single value, not a list.`);
  }
  return String(value ?? "");
}

/** Flatten whatever PostgREST returns into the scalars the protocol can store. */
function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  // Dates arrive as strings already; objects and arrays are JSON columns, which
  // would otherwise blow past the protocol's depth bound.
  return JSON.stringify(value);
}

export function makeSupabaseReader(
  config: SupabaseConfig,
  scope: RunScope
): SupabaseReader {
  return {
    async describe(resource): Promise<ResourceDescription[]> {
      const entries =
        resource === null
          ? config.allowlist
          : [findResource(config.allowlist, resource)].filter(
              (e): e is NonNullable<typeof e> => e !== null
            );

      if (resource !== null && entries.length === 0) {
        throw invalid(unknownResourceMessage(config.allowlist, resource));
      }
      // tenantColumn is deliberately not published: it is enforcement, not a
      // field the model should reason about or try to filter on itself.
      return entries.map((entry) => ({
        resource: entry.resource,
        columns: entry.columns.map((c) => ({ name: c.name, type: c.type })),
      }));
    },

    async select(input): Promise<Row[]> {
      const entry = findResource(config.allowlist, input.resource);
      if (entry === null) {
        throw invalid(unknownResourceMessage(config.allowlist, input.resource));
      }

      const allowedColumns = new Set(entry.columns.map((c) => c.name));
      const projection = input.columns ?? entry.columns.map((c) => c.name);
      for (const column of projection) {
        if (!allowedColumns.has(column)) {
          throw invalid(
            `unknown column "${column}" on ${entry.resource}. Call schema() to see what is readable.`
          );
        }
      }

      const params = new URLSearchParams();
      params.set("select", projection.join(","));

      for (const filter of input.filters) {
        if (!allowedColumns.has(filter.column)) {
          throw invalid(
            `unknown column "${filter.column}" on ${entry.resource}.`
          );
        }
        // A model filter on the tenant column is dropped, not honoured. Letting
        // it through would let a caller widen or redirect its own scope.
        if (
          entry.tenantColumn !== null &&
          filter.column === entry.tenantColumn
        ) {
          throw invalid(
            `"${filter.column}" is scoped automatically and cannot be filtered here.`
          );
        }
        const op = OPERATORS[filter.op];
        if (op === undefined)
          throw invalid(`unsupported operator "${filter.op}".`);
        params.append(
          filter.column,
          `${op}.${encodeValue(filter.op, filter.value)}`
        );
      }

      // The tenant predicate goes on last and unconditionally.
      if (entry.tenantColumn !== null) {
        if (scope.customerSlug === null) {
          throw new CapabilityError(
            "customer_scope_required",
            `reads from ${entry.resource} are per-customer and this run has no customer. Ask which customer this concerns.`
          );
        }
        params.append(entry.tenantColumn, `eq.${scope.customerSlug}`);
      }

      if (input.order !== null) {
        if (!allowedColumns.has(input.order.column)) {
          throw invalid(
            `cannot order by unknown column "${input.order.column}".`
          );
        }
        params.set("order", `${input.order.column}.${input.order.direction}`);
      }
      params.set("limit", String(Math.min(Math.max(input.limit, 1), MAX_ROWS)));

      // The resource is an allowlisted literal, so it is the one part of the
      // path that is not caller-controlled. Everything else is a query value.
      const url = `${config.url}/rest/v1/${entry.resource}?${params.toString()}`;

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            apikey: config.key,
            authorization: `Bearer ${config.key}`,
            accept: "application/json",
          },
        });
      } catch {
        throw new CapabilityError(
          "upstream_unavailable",
          "the product database could not be reached."
        );
      }

      if (!response.ok) {
        throw new CapabilityError(
          "upstream_unavailable",
          `the product database refused the read (status ${response.status}).`
        );
      }

      let rows: unknown;
      try {
        rows = await response.json();
      } catch {
        throw new CapabilityError(
          "upstream_unavailable",
          "the product database returned something unreadable."
        );
      }
      if (!Array.isArray(rows)) {
        throw new CapabilityError(
          "upstream_unavailable",
          "the product database returned an unexpected shape."
        );
      }

      // Project again on the way out. The query already asked for these columns,
      // but a second pass means a policy change upstream cannot widen what
      // reaches model context without this list changing too.
      return rows.map((raw) => {
        const source = (raw ?? {}) as Record<string, unknown>;
        const out: Row = {};
        for (const column of projection) {
          out[column] = normalizeCell(source[column]);
        }
        return out;
      });
    },
  };
}

function unknownResourceMessage(
  allowlist: SupabaseAllowlist,
  resource: string
): string {
  const names = allowlist.map((e) => e.resource).join(", ");
  return names.length === 0
    ? `"${resource}" is not readable. No product resources are configured yet, so this capability cannot answer anything.`
    : `"${resource}" is not readable. Available resources are: ${names}.`;
}
