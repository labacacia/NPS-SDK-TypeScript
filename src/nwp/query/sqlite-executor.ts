// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Concrete ISqlExecutor over the built-in `node:sqlite` module (Node ≥ 22.5).
// Provides a real, driver-backed Memory Node provider for embedded / test use,
// and demonstrates the `@pN` → positional-`?` rewrite. Postgres / SQL Server
// executors bind the same interface once their (native) drivers are available.

import type { DatabaseSync } from "node:sqlite";
import type { SqlParameters } from "./filter-translator.js";
import { expandNamedParameters, type ISqlExecutor, type SqlRow } from "./sql-executor.js";

/**
 * `ISqlExecutor` backed by a `node:sqlite` `DatabaseSync` handle. SQLite uses
 * `?` positional placeholders, so array (`IN`) parameters are expanded inline.
 */
export class SqliteExecutor implements ISqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  query(sql: string, params: SqlParameters): Promise<SqlRow[]> {
    const { sql: rewritten, args } = expandNamedParameters(sql, params, () => "?");
    const stmt = this.db.prepare(rewritten);
    const rows = stmt.all(...(args as never[])) as SqlRow[];
    return Promise.resolve(rows);
  }

  scalar(sql: string, params: SqlParameters): Promise<number> {
    const { sql: rewritten, args } = expandNamedParameters(sql, params, () => "?");
    const stmt = this.db.prepare(rewritten);
    const row = stmt.get(...(args as never[])) as Record<string, unknown> | undefined;
    if (!row) return Promise.resolve(0);
    const first = Object.values(row)[0];
    return Promise.resolve(typeof first === "bigint" ? Number(first) : Number(first ?? 0));
  }
}
