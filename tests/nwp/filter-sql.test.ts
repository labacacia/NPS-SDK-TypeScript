// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Filter→SQL translation table + SqlQueryBuilder tests. Asserts the WHERE
// clause / full-query text and parameter bag match the .NET reference.

import { describe, it, expect } from "vitest";
import { QueryFrame } from "../../src/nwp/frames.js";
import {
  DatabaseDialect,
  SqlMemoryNodeSchema,
  NwpFilterTranslator,
  NwpFilterError,
  SqlParameters,
  SqlQueryBuilder,
} from "../../src/nwp/query/index.js";

const schema = new SqlMemoryNodeSchema({
  tableName: "products",
  primaryKey: "id",
  fields: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "price", type: "number" },
    { name: "active", type: "boolean" },
    { name: "sku", type: "string", columnName: "stock_keeping_unit" },
  ],
});

function translate(
  filter: Record<string, unknown> | null,
  dialect = DatabaseDialect.PostgreSql,
): { sql: string; params: Record<string, unknown> } {
  const t = new NwpFilterTranslator(schema, dialect);
  const p = new SqlParameters();
  const sql = t.translate(filter, p);
  return { sql, params: p.toObject() };
}

describe("NwpFilterTranslator — comparison operators", () => {
  const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ["$eq", { price: { $eq: 10 } }, `"price" = @p0`, { p0: 10 }],
    ["$ne", { price: { $ne: 10 } }, `"price" <> @p0`, { p0: 10 }],
    ["$lt", { price: { $lt: 10 } }, `"price" < @p0`, { p0: 10 }],
    ["$lte", { price: { $lte: 10 } }, `"price" <= @p0`, { p0: 10 }],
    ["$gt", { price: { $gt: 10 } }, `"price" > @p0`, { p0: 10 }],
    ["$gte", { price: { $gte: 10 } }, `"price" >= @p0`, { p0: 10 }],
    ["$contains", { name: { $contains: "wid" } }, `"name" LIKE @p0`, { p0: "%wid%" }],
    ["$eq string", { name: { $eq: "widget" } }, `"name" = @p0`, { p0: "widget" }],
    ["$eq bool", { active: { $eq: true } }, `"active" = @p0`, { p0: true }],
  ];

  for (const [label, filter, expectSql, expectParams] of cases) {
    it(`translates ${label}`, () => {
      const { sql, params } = translate(filter);
      expect(sql).toBe(expectSql);
      expect(params).toEqual(expectParams);
    });
  }
});

describe("NwpFilterTranslator — $in / $nin / $between", () => {
  it("$in binds an array to a single parameter", () => {
    const { sql, params } = translate({ price: { $in: [1, 2, 3] } });
    expect(sql).toBe(`"price" IN @p0`);
    expect(params).toEqual({ p0: [1, 2, 3] });
  });

  it("$nin renders NOT IN", () => {
    const { sql, params } = translate({ price: { $nin: [1, 2] } });
    expect(sql).toBe(`"price" NOT IN @p0`);
    expect(params).toEqual({ p0: [1, 2] });
  });

  it("empty $in → 1=0 (always false)", () => {
    const { sql } = translate({ price: { $in: [] } });
    expect(sql).toBe("1=0");
  });

  it("empty $nin → 1=1 (always true)", () => {
    const { sql } = translate({ price: { $nin: [] } });
    expect(sql).toBe("1=1");
  });

  it("$between renders BETWEEN with two params", () => {
    const { sql, params } = translate({ price: { $between: [5, 20] } });
    expect(sql).toBe(`"price" BETWEEN @p0 AND @p1`);
    expect(params).toEqual({ p0: 5, p1: 20 });
  });

  it("$between with wrong arity throws", () => {
    expect(() => translate({ price: { $between: [5] } })).toThrow(NwpFilterError);
  });
});

describe("NwpFilterTranslator — logical operators", () => {
  it("$and joins with AND", () => {
    const { sql, params } = translate({
      $and: [{ price: { $gt: 5 } }, { active: { $eq: true } }],
    });
    expect(sql).toBe(`("price" > @p0 AND "active" = @p1)`);
    expect(params).toEqual({ p0: 5, p1: true });
  });

  it("$or joins with OR", () => {
    const { sql } = translate({
      $or: [{ price: { $lt: 5 } }, { price: { $gt: 100 } }],
    });
    expect(sql).toBe(`("price" < @p0 OR "price" > @p1)`);
  });

  it("implicit top-level AND wraps multiple fields", () => {
    const { sql } = translate({ price: { $gt: 5 }, active: { $eq: true } });
    expect(sql).toBe(`("price" > @p0 AND "active" = @p1)`);
  });

  it("nested $and/$or", () => {
    const { sql } = translate({
      $and: [{ active: { $eq: true } }, { $or: [{ price: { $lt: 5 } }, { price: { $gt: 100 } }] }],
    });
    expect(sql).toBe(`("active" = @p0 AND ("price" < @p1 OR "price" > @p2))`);
  });

  it("$and requires an array", () => {
    expect(() => translate({ $and: { price: { $gt: 5 } } as unknown as unknown[] })).toThrow(
      NwpFilterError,
    );
  });
});

describe("NwpFilterTranslator — validation & dialects", () => {
  it("unknown field throws NWP-QUERY-FIELD-UNKNOWN", () => {
    try {
      translate({ nope: { $eq: 1 } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NwpFilterError);
      expect((e as NwpFilterError).nwpErrorCode).toBe("NWP-QUERY-FIELD-UNKNOWN");
    }
  });

  it("unknown operator throws", () => {
    expect(() => translate({ price: { $weird: 1 } })).toThrow(NwpFilterError);
  });

  it("SQL Server uses bracket quoting", () => {
    const { sql } = translate({ price: { $eq: 10 } }, DatabaseDialect.SqlServer);
    expect(sql).toBe(`[price] = @p0`);
  });

  it("resolves column name aliases", () => {
    const { sql } = translate({ sku: { $eq: "ABC" } });
    expect(sql).toBe(`"stock_keeping_unit" = @p0`);
  });

  it("null filter → empty string", () => {
    expect(translate(null).sql).toBe("");
  });
});

describe("SqlQueryBuilder — full SELECT", () => {
  const opts = { defaultLimit: 20, maxLimit: 1000 };

  it("builds a Postgres SELECT with default projection, order, pagination", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, { price: { $gt: 5 } });
    const { sql, params } = builder.build(frame, opts);
    expect(sql).toBe(
      `SELECT "id", "name", "price", "active", "stock_keeping_unit" FROM "products"` +
        ` WHERE "price" > @p0 ORDER BY "id" LIMIT @_limit OFFSET @_offset`,
    );
    expect(params.toObject()).toEqual({ p0: 5, _limit: 20, _offset: 0 });
  });

  it("builds a SQL Server SELECT with OFFSET/FETCH pagination", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.SqlServer);
    const frame = new QueryFrame(undefined, undefined, 50);
    const { sql, params } = builder.build(frame, opts);
    expect(sql).toBe(
      `SELECT [id], [name], [price], [active], [stock_keeping_unit] FROM [products]` +
        ` ORDER BY [id] OFFSET @_offset ROWS FETCH NEXT @_limit ROWS ONLY`,
    );
    expect(params.toObject()._limit).toBe(50);
  });

  it("clamps limit to maxLimit", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, undefined, 99999);
    const { params } = builder.build(frame, opts);
    expect(params.toObject()._limit).toBe(1000);
  });

  it("projects a field subset, aliasing renamed columns", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, undefined, undefined, undefined, undefined, [
      "name",
      "sku",
    ]);
    const { sql } = builder.build(frame, opts);
    expect(sql).toContain(`SELECT "name", "stock_keeping_unit" AS "sku" FROM "products"`);
  });

  it("applies ORDER BY clauses", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, undefined, undefined, undefined, [
      { field: "price", dir: "desc" },
      { field: "name", dir: "asc" },
    ]);
    const { sql } = builder.build(frame, opts);
    expect(sql).toContain(`ORDER BY "price" DESC, "name" ASC`);
  });

  it("builds COUNT(*)", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, { active: { $eq: true } });
    const { sql, params } = builder.buildCount(frame);
    expect(sql).toBe(`SELECT COUNT(*) FROM "products" WHERE "active" = @p0`);
    expect(params.toObject()).toEqual({ p0: true });
  });

  it("unknown projection field throws", () => {
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(undefined, undefined, undefined, undefined, undefined, ["nope"]);
    expect(() => builder.build(frame, opts)).toThrow(NwpFilterError);
  });
});

describe("SqlQueryBuilder — cursor round-trip", () => {
  it("encodes/decodes a Base64-URL offset cursor", () => {
    const c = SqlQueryBuilder.encodeCursor(40);
    expect(c).toBeTruthy();
    expect(SqlQueryBuilder.decodeCursor(c)).toBe(40);
  });

  it("offset 0 encodes to null", () => {
    expect(SqlQueryBuilder.encodeCursor(0)).toBeNull();
  });

  it("invalid cursor decodes to 0", () => {
    expect(SqlQueryBuilder.decodeCursor("not-a-cursor")).toBe(0);
    expect(SqlQueryBuilder.decodeCursor(undefined)).toBe(0);
  });

  it("cursor decodes into the query OFFSET", () => {
    const cursor = SqlQueryBuilder.encodeCursor(20)!;
    const builder = new SqlQueryBuilder(schema, DatabaseDialect.PostgreSql);
    const frame = new QueryFrame(
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cursor,
    );
    const { params } = builder.build(frame, { defaultLimit: 20, maxLimit: 1000 });
    expect(params.toObject()._offset).toBe(20);
  });

  it("matches the exact .NET Base64-URL encoding for offset 40", () => {
    // .NET: base64url(utf8('{"o":40}')) trimmed of '=' → "eyJvIjo0MH0"
    expect(SqlQueryBuilder.encodeCursor(40)).toBe("eyJvIjo0MH0");
  });
});
