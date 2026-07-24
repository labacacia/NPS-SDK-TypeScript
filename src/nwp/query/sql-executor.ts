// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Injectable async SQL executor abstraction for Memory Node providers.
// Lets the SQL-backed providers (Postgres / SQL Server / SQLite) be unit-tested
// without a live database driver, and keeps the .NET Dapper-style `@pN`
// parameter model portable across engines.

import type { SqlParameters } from "./filter-translator.js";

/** A single result row as a field-name → value map. */
export type SqlRow = Record<string, unknown>;

/**
 * Executes parameterized SQL. Implementations bind the ordered {@link
 * SqlParameters} (`@p0`, `@p1`, `@_limit`, …) — including array parameters
 * produced by `$in`/`$nin` — to whatever placeholder syntax the driver uses.
 */
export interface ISqlExecutor {
  /** Runs a SELECT and returns all rows. */
  query(sql: string, params: SqlParameters): Promise<SqlRow[]>;
  /** Runs a scalar query (e.g. COUNT(*)) and returns the first column of the first row. */
  scalar(sql: string, params: SqlParameters): Promise<number>;
}

/**
 * Rewrites the .NET/Dapper `@name` SQL — including `IN @name` bound to an array
 * — into positional-placeholder SQL plus a flat, ordered argument list.
 *
 * `col IN @p0` where `@p0 = [1,2,3]` becomes `col IN (?, ?, ?)` with args
 * `[1, 2, 3]`. Scalar params become a single placeholder. This is what a real
 * driver needs; the raw `SqlQueryBuilder` output stays faithful to .NET at the
 * boundary while execution is driver-portable.
 *
 * @param placeholder Factory for the positional placeholder given its 1-based
 *   index (e.g. `() => "?"` for SQLite, `(i) => "$" + i` for Postgres).
 */
export function expandNamedParameters(
  sql: string,
  params: SqlParameters,
  placeholder: (oneBasedIndex: number) => string,
): { sql: string; args: unknown[] } {
  const args: unknown[] = [];
  let counter = 0;

  // Match `@name` tokens (name = word chars). Longest-first is guaranteed by
  // the regex being anchored on `@` followed by the full identifier.
  const rewritten = sql.replace(/@([A-Za-z_]\w*)/g, (_m, name: string) => {
    const value = params.get(name);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        // Should not happen — the translator emits 1=0 / 1=1 for empty IN.
        return "(NULL)";
      }
      const holders = value.map((v) => {
        args.push(v);
        return placeholder(++counter);
      });
      return `(${holders.join(", ")})`;
    }
    args.push(value);
    return placeholder(++counter);
  });

  return { sql: rewritten, args };
}
