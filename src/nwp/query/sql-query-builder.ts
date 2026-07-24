// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Builds a complete parameterized SELECT query from a QueryFrame, handling
// field projection, filter, ordering, and cursor-based pagination.
// Port of the .NET `NPS.NWP.MemoryNode.Query.SqlQueryBuilder`.
//
// Dialect-specific quoting and LIMIT syntax is injected via DatabaseDialect.
// The emitted SQL and Base64-URL cursor encoding match the .NET reference
// byte-for-byte.

import type { QueryFrame, QueryOrderClause } from "../frames.js";
import { NWP_QUERY_FIELD_UNKNOWN } from "../nwp-error-codes.js";
import { NwpFilterError, NwpFilterTranslator, SqlParameters } from "./filter-translator.js";
import {
  DatabaseDialect,
  SqlMemoryNodeSchema,
  resolvedColumnName,
} from "./sql-schema.js";

/** Query-limit options for the SQL builder (subset of MemoryNodeOptions). */
export interface SqlQueryOptions {
  defaultLimit: number;
  maxLimit: number;
}

/** Result of a build: the SQL text and its ordered parameter bag. */
export interface BuiltQuery {
  sql: string;
  params: SqlParameters;
}

export class SqlQueryBuilder {
  private readonly schema: SqlMemoryNodeSchema;
  private readonly dialect: DatabaseDialect;
  private readonly filter: NwpFilterTranslator;

  constructor(schema: SqlMemoryNodeSchema, dialect: DatabaseDialect) {
    this.schema = schema;
    this.dialect = dialect;
    this.filter = new NwpFilterTranslator(schema, dialect);
  }

  /** Builds the full SELECT query and its parameters. */
  build(frame: QueryFrame, options: SqlQueryOptions): BuiltQuery {
    const p = new SqlParameters();
    const parts: string[] = [];

    const frameLimit = frame.limit ?? 0;
    const limit = Math.min(frameLimit === 0 ? options.defaultLimit : frameLimit, options.maxLimit);
    const offset = SqlQueryBuilder.decodeCursor(frame.cursor);

    // SELECT
    parts.push("SELECT " + this.buildSelectList(frame.fields));

    // FROM
    parts.push(" FROM " + this.quoteTable(this.schema.tableName));

    // WHERE
    const where = this.filter.translate(frame.filter ?? null, p);
    if (where.length > 0) parts.push(" WHERE " + where);

    // ORDER BY (required for stable pagination)
    if (frame.orderBy && frame.orderBy.length > 0) {
      parts.push(" ORDER BY " + this.buildOrderBy(frame.orderBy));
    } else {
      parts.push(" ORDER BY " + this.quoteColumn(this.schema.primaryKey));
    }

    // PAGINATION — dialect-specific syntax
    if (this.dialect === DatabaseDialect.SqlServer) {
      parts.push(" OFFSET @_offset ROWS FETCH NEXT @_limit ROWS ONLY");
    } else {
      parts.push(" LIMIT @_limit OFFSET @_offset");
    }

    p.add("_limit", limit);
    p.add("_offset", offset);

    return { sql: parts.join(""), params: p };
  }

  /** Builds a COUNT(*) query for the same filter (used for cursor validation). */
  buildCount(frame: QueryFrame): BuiltQuery {
    const p = new SqlParameters();
    const parts: string[] = [];

    parts.push("SELECT COUNT(*) FROM " + this.quoteTable(this.schema.tableName));

    const where = this.filter.translate(frame.filter ?? null, p);
    if (where.length > 0) parts.push(" WHERE " + where);

    return { sql: parts.join(""), params: p };
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────

  /** Encodes a row offset as an opaque Base64-URL cursor. */
  static encodeCursor(nextOffset: number): string | null {
    if (nextOffset <= 0) return null;
    const raw = Buffer.from(`{"o":${nextOffset}}`, "utf-8").toString("base64");
    return raw.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  /** Decodes a Base64-URL cursor back to a row offset. Returns 0 for null/invalid. */
  static decodeCursor(cursor: string | null | undefined): number {
    if (!cursor) return 0;
    try {
      let padded = cursor.replace(/-/g, "+").replace(/_/g, "/");
      const rem = padded.length % 4;
      if (rem === 2) padded += "==";
      else if (rem === 3) padded += "=";
      const json = Buffer.from(padded, "base64").toString("utf-8");
      const doc = JSON.parse(json) as Record<string, unknown>;
      const o = doc["o"];
      return typeof o === "number" && Number.isFinite(o) ? Math.trunc(o) : 0;
    } catch {
      return 0;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private buildSelectList(fields: readonly string[] | null | undefined): string {
    if (!fields || fields.length === 0) {
      // Return all declared schema fields (not SELECT *, to avoid schema drift)
      return this.schema.fields.map((f) => this.quoteColumn(resolvedColumnName(f))).join(", ");
    }

    for (const name of fields) {
      if (!this.schema.hasField(name))
        throw new NwpFilterError(`Unknown field '${name}'.`, NWP_QUERY_FIELD_UNKNOWN);
    }

    return fields
      .map((name) => {
        const f = this.schema.getField(name)!;
        const col = this.quoteColumn(resolvedColumnName(f));
        // Alias back to the NWP name if column name differs
        return f.columnName !== undefined && f.columnName !== null
          ? `${col} AS ${this.quoteColumn(f.name)}`
          : col;
      })
      .join(", ");
  }

  private buildOrderBy(order: readonly QueryOrderClause[]): string {
    return order
      .map((o) => {
        const field = this.schema.getField(o.field);
        if (!field)
          throw new NwpFilterError(`Unknown order field '${o.field}'.`, NWP_QUERY_FIELD_UNKNOWN);
        const dir = String(o.dir).toUpperCase() === "DESC" ? "DESC" : "ASC";
        return `${this.quoteColumn(resolvedColumnName(field))} ${dir}`;
      })
      .join(", ");
  }

  private quoteColumn(col: string): string {
    return this.dialect === DatabaseDialect.SqlServer ? `[${col}]` : `"${col}"`;
  }

  private quoteTable(table: string): string {
    return this.dialect === DatabaseDialect.SqlServer ? `[${table}]` : `"${table}"`;
  }
}
