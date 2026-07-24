// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// SqlMemoryNodeProvider tests. Runs against a real `node:sqlite` DB via the
// SqliteExecutor, plus a mock executor to assert pagination/cursor arithmetic.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { QueryFrame } from "../../src/nwp/frames.js";
import {
  DatabaseDialect,
  SqlMemoryNodeSchema,
  SqlMemoryNodeProvider,
  SqliteExecutor,
  SqlQueryBuilder,
  createPostgreSqlMemoryNodeProvider,
  expandNamedParameters,
  SqlParameters,
  type ISqlExecutor,
  type SqlRow,
} from "../../src/nwp/query/index.js";

const schema = new SqlMemoryNodeSchema({
  tableName: "products",
  primaryKey: "id",
  fields: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
    { name: "price", type: "number" },
  ],
});

function seedDb(rows: Array<{ id: number; name: string; price: number }>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE "products" (id INTEGER PRIMARY KEY, name TEXT, price REAL)`);
  const stmt = db.prepare(`INSERT INTO "products" (id, name, price) VALUES (?, ?, ?)`);
  for (const r of rows) stmt.run(r.id, r.name, r.price);
  return db;
}

describe("expandNamedParameters", () => {
  it("rewrites scalar @params to positional ?", () => {
    const p = new SqlParameters();
    p.add("p0", 5);
    p.add("_limit", 20);
    p.add("_offset", 0);
    const { sql, args } = expandNamedParameters(
      `SELECT * FROM t WHERE price > @p0 LIMIT @_limit OFFSET @_offset`,
      p,
      () => "?",
    );
    expect(sql).toBe("SELECT * FROM t WHERE price > ? LIMIT ? OFFSET ?");
    expect(args).toEqual([5, 20, 0]);
  });

  it("expands array (IN) params into a placeholder group", () => {
    const p = new SqlParameters();
    p.add("p0", [10, 20, 30]);
    const { sql, args } = expandNamedParameters(`SELECT * FROM t WHERE id IN @p0`, p, () => "?");
    expect(sql).toBe("SELECT * FROM t WHERE id IN (?, ?, ?)");
    expect(args).toEqual([10, 20, 30]);
  });

  it("supports positional $n placeholders (Postgres style)", () => {
    const p = new SqlParameters();
    p.add("p0", "x");
    p.add("p1", [1, 2]);
    const { sql } = expandNamedParameters(
      `SELECT * FROM t WHERE a = @p0 AND b IN @p1`,
      p,
      (i) => `$${i}`,
    );
    expect(sql).toBe("SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)");
  });
});

describe("SqlMemoryNodeProvider — sqlite executor", () => {
  it("queries rows through the real driver", async () => {
    const db = seedDb([
      { id: 1, name: "a", price: 5 },
      { id: 2, name: "b", price: 15 },
      { id: 3, name: "c", price: 25 },
    ]);
    const provider = createPostgreSqlMemoryNodeProvider(new SqliteExecutor(db), schema);
    const frame = new QueryFrame(undefined, { price: { $gt: 10 } });
    const result = await provider.query(frame, { defaultLimit: 20, maxLimit: 1000 });
    expect(result.rows.map((r) => r.name)).toEqual(["b", "c"]);
    expect(result.nextCursor).toBeUndefined();
    db.close();
  });

  it("handles $in via array expansion", async () => {
    const db = seedDb([
      { id: 1, name: "a", price: 5 },
      { id: 2, name: "b", price: 15 },
      { id: 3, name: "c", price: 25 },
    ]);
    const provider = createPostgreSqlMemoryNodeProvider(new SqliteExecutor(db), schema);
    const frame = new QueryFrame(undefined, { id: { $in: [1, 3] } });
    const result = await provider.query(frame, {});
    expect(result.rows.map((r) => r.id)).toEqual([1, 3]);
    db.close();
  });

  it("paginates with a next cursor when a full page is returned", async () => {
    const db = seedDb(
      Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `n${i}`, price: i })),
    );
    const provider = createPostgreSqlMemoryNodeProvider(new SqliteExecutor(db), schema);
    const page1 = await provider.query(new QueryFrame(undefined, undefined, 2), {});
    expect(page1.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(page1.nextCursor).toBe(SqlQueryBuilder.encodeCursor(2));

    const page2 = await provider.query(
      new QueryFrame(undefined, undefined, 2, undefined, undefined, undefined, undefined, undefined, page1.nextCursor),
      {},
    );
    expect(page2.rows.map((r) => r.id)).toEqual([3, 4]);
    db.close();
  });

  it("counts matching rows", async () => {
    const db = seedDb([
      { id: 1, name: "a", price: 5 },
      { id: 2, name: "b", price: 15 },
    ]);
    const provider = createPostgreSqlMemoryNodeProvider(new SqliteExecutor(db), schema);
    const n = await provider.count(new QueryFrame(undefined, { price: { $gt: 10 } }));
    expect(n).toBe(1);
    db.close();
  });

  it("streams pages until exhausted", async () => {
    const db = seedDb(
      Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `n${i}`, price: i })),
    );
    const provider = createPostgreSqlMemoryNodeProvider(new SqliteExecutor(db), schema);
    const pages: number[][] = [];
    for await (const page of provider.stream(new QueryFrame(undefined, undefined, 2), {})) {
      pages.push(page.map((r) => Number(r.id)));
    }
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    db.close();
  });
});

describe("SqlMemoryNodeProvider — injectable mock executor", () => {
  it("computes nextCursor when rows.length === limit", async () => {
    const mock: ISqlExecutor = {
      query: (): Promise<SqlRow[]> =>
        Promise.resolve([{ id: 1 }, { id: 2 }]),
      scalar: (): Promise<number> => Promise.resolve(2),
    };
    const provider = new SqlMemoryNodeProvider(mock, schema, DatabaseDialect.PostgreSql);
    const result = await provider.query(new QueryFrame(undefined, undefined, 2), {});
    expect(result.nextCursor).toBe(SqlQueryBuilder.encodeCursor(2));
  });

  it("no cursor when page is under-full", async () => {
    const mock: ISqlExecutor = {
      query: (): Promise<SqlRow[]> => Promise.resolve([{ id: 1 }]),
      scalar: (): Promise<number> => Promise.resolve(1),
    };
    const provider = new SqlMemoryNodeProvider(mock, schema, DatabaseDialect.PostgreSql);
    const result = await provider.query(new QueryFrame(undefined, undefined, 5), {});
    expect(result.nextCursor).toBeUndefined();
  });
});
