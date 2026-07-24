// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// SQL-backed Memory Node provider (NPS-2 §2.1). Port of the .NET
// `PostgreSqlMemoryNodeProvider` / `SqlServerMemoryNodeProvider`, refactored
// around an injectable `ISqlExecutor` so it is testable without a live DB and
// so a single implementation serves every dialect.
//
// The paging / cursor arithmetic mirrors the .NET providers exactly:
//   nextCursor = rows.Count == limit ? encode(decode(cursor) + limit) : null

import type { QueryFrame } from "../frames.js";
import type { MemoryNodeQueryResult, MemoryNodeRow } from "../memory-server.js";
import { DatabaseDialect, SqlMemoryNodeSchema } from "./sql-schema.js";
import { SqlQueryBuilder } from "./sql-query-builder.js";
import type { ISqlExecutor, SqlRow } from "./sql-executor.js";

/** Query-limit options consumed by the provider (subset of MemoryNodeOptions). */
export interface SqlMemoryNodeProviderOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

/**
 * Dialect-agnostic Memory Node provider driven by an injectable executor.
 * Instantiate directly or via {@link createPostgreSqlMemoryNodeProvider} /
 * {@link createSqlServerMemoryNodeProvider}.
 */
export class SqlMemoryNodeProvider {
  private readonly executor: ISqlExecutor;
  private readonly schema: SqlMemoryNodeSchema;
  private readonly dialect: DatabaseDialect;
  private readonly builder: SqlQueryBuilder;

  constructor(executor: ISqlExecutor, schema: SqlMemoryNodeSchema, dialect: DatabaseDialect) {
    this.executor = executor;
    this.schema = schema;
    this.dialect = dialect;
    this.builder = new SqlQueryBuilder(schema, dialect);
  }

  private resolveLimits(opts: SqlMemoryNodeProviderOptions) {
    return {
      defaultLimit: opts.defaultLimit ?? 20,
      maxLimit: opts.maxLimit ?? 1000,
    };
  }

  /** Executes a query and returns a paginated result (NPS-2 §5). */
  async query(
    frame: QueryFrame,
    opts: SqlMemoryNodeProviderOptions = {},
  ): Promise<MemoryNodeQueryResult> {
    const limits = this.resolveLimits(opts);
    const { sql, params } = this.builder.build(frame, limits);
    const rows = mapRows(await this.executor.query(sql, params));

    const frameLimit = frame.limit ?? 0;
    const limit = Math.min(
      frameLimit === 0 ? limits.defaultLimit : frameLimit,
      limits.maxLimit,
    );
    const nextCursor =
      rows.length === limit
        ? SqlQueryBuilder.encodeCursor(SqlQueryBuilder.decodeCursor(frame.cursor) + limit)
        : null;

    return { rows, nextCursor: nextCursor ?? undefined };
  }

  /** Streams matching rows page-by-page (for the `/stream` endpoint). */
  async *stream(
    frame: QueryFrame,
    opts: SqlMemoryNodeProviderOptions = {},
  ): AsyncIterable<MemoryNodeRow[]> {
    const limits = this.resolveLimits(opts);
    const frameLimit = frame.limit ?? 0;
    const pageLimit = Math.min(
      frameLimit === 0 ? limits.defaultLimit : frameLimit,
      limits.maxLimit,
    );
    let cursor = frame.cursor;
    let hasMore = true;

    while (hasMore) {
      const pageFrame = withCursorAndLimit(frame, cursor, pageLimit);
      const { sql, params } = this.builder.build(pageFrame, limits);
      const rows = mapRows(await this.executor.query(sql, params));

      if (rows.length === 0) break;

      yield rows;

      hasMore = rows.length === pageLimit;
      cursor = SqlQueryBuilder.encodeCursor(
        SqlQueryBuilder.decodeCursor(cursor) + rows.length,
      ) ?? undefined;
    }
  }

  /** Returns the total row count matching the frame's filter. */
  async count(frame: QueryFrame): Promise<number> {
    const { sql, params } = this.builder.buildCount(frame);
    return this.executor.scalar(sql, params);
  }
}

/** Creates a provider bound to the PostgreSQL dialect. */
export function createPostgreSqlMemoryNodeProvider(
  executor: ISqlExecutor,
  schema: SqlMemoryNodeSchema,
): SqlMemoryNodeProvider {
  return new SqlMemoryNodeProvider(executor, schema, DatabaseDialect.PostgreSql);
}

/** Creates a provider bound to the SQL Server dialect. */
export function createSqlServerMemoryNodeProvider(
  executor: ISqlExecutor,
  schema: SqlMemoryNodeSchema,
): SqlMemoryNodeProvider {
  return new SqlMemoryNodeProvider(executor, schema, DatabaseDialect.SqlServer);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapRows(rows: SqlRow[]): MemoryNodeRow[] {
  // Normalise SQL NULL sentinels to JS null (SQLite already returns null;
  // driver adapters map DBNull → null before reaching here).
  return rows.map((r) => {
    const out: MemoryNodeRow = {};
    for (const [k, v] of Object.entries(r)) out[k] = v === undefined ? null : v;
    return out;
  });
}

/** Rebuilds a QueryFrame with a new cursor + limit, preserving other fields. */
function withCursorAndLimit(frame: QueryFrame, cursor: string | undefined, limit: number): QueryFrame {
  // QueryFrame is immutable with a positional constructor; reconstruct it.
  const Ctor = frame.constructor as {
    new (
      anchorRef?: string,
      filter?: Record<string, unknown>,
      limit?: number,
      offset?: number,
      orderBy?: readonly unknown[],
      fields?: readonly string[],
      vectorSearch?: unknown,
      depth?: number,
      cursor?: string,
    ): QueryFrame;
  };
  return new Ctor(
    frame.anchorRef,
    frame.filter,
    limit,
    frame.offset,
    frame.orderBy,
    frame.fields,
    frame.vectorSearch,
    frame.depth,
    cursor,
  );
}
