// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryNodeProvider,
  MemoryNodeApp,
  type MemoryNodeOptions,
  type MemoryNodeRow,
} from "../src/nwp/memory-server.js";
import * as EC from "../src/nwp/nwp-error-codes.js";

const PREFIX = "/products";
const NODE = "urn:nps:node:api.example.com:products";

const ROWS: MemoryNodeRow[] = [
  { id: 1, name: "alpha", price: 10, tags: ["a"] },
  { id: 2, name: "bravo", price: 20, tags: ["b"] },
  { id: 3, name: "charlie", price: 30, tags: ["a", "b"] },
];

function baseOptions(over: Partial<MemoryNodeOptions> = {}): MemoryNodeOptions {
  return {
    nodeId: NODE,
    pathPrefix: PREFIX,
    schema: {
      tableName: "products",
      primaryKey: "id",
      fields: [
        { name: "id", type: "number", nullable: false },
        { name: "name", type: "string" },
        { name: "price", type: "number" },
        { name: "tags", type: "object" },
      ],
    },
    ...over,
  };
}

function makeApp(rows = ROWS, over: Partial<MemoryNodeOptions> = {}): MemoryNodeApp {
  return new MemoryNodeApp(new InMemoryMemoryNodeProvider(rows), baseOptions(over));
}

function query(app: MemoryNodeApp, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Response> {
  return app.fetch(new Request(`http://memory${PREFIX}/query`, {
    method: "POST", headers, body: JSON.stringify(body),
  }));
}

describe("memory-server: manifest & schema", () => {
  it("nwm advertises query + stream", async () => {
    const app = makeApp();
    const m = await (await app.fetch(new Request(`http://memory${PREFIX}/.nwm`))).json();
    expect(m.node_type).toBe("memory");
    expect(m.capabilities.query).toBe(true);
    expect(m.capabilities.stream).toBe(true);
    expect(m.endpoints).toEqual({ query: `${PREFIX}/query`, stream: `${PREFIX}/stream`, schema: `${PREFIX}/.schema` });
    expect(m.schema_anchors.default).toMatch(/^sha256:/);
  });

  it("/.schema echoes the anchor id header", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://memory${PREFIX}/.schema`));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-nwp-schema")).toMatch(/^sha256:/);
  });
});

describe("memory-server: query filtering", () => {
  it("returns all rows with count + token_est", async () => {
    const app = makeApp();
    const r = await query(app, {});
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/nwp-capsule");
    const body = await r.json();
    expect(body.count).toBe(3);
    expect(body.token_est).toBeGreaterThan(0);
    expect(Number(r.headers.get("x-nwp-tokens"))).toBe(body.token_est);
  });

  it("applies an equality filter", async () => {
    const app = makeApp();
    const body = await (await query(app, { filter: { name: "bravo" } })).json();
    expect(body.count).toBe(1);
    expect(body.data[0].id).toBe(2);
  });

  it("applies comparison + $in operators", async () => {
    const app = makeApp();
    const gt = await (await query(app, { filter: { price: { $gte: 20 } } })).json();
    expect(gt.data.map((r: MemoryNodeRow) => r.id).sort()).toEqual([2, 3]);
    const inl = await (await query(app, { filter: { id: { $in: [1, 3] } } })).json();
    expect(inl.data.map((r: MemoryNodeRow) => r.id).sort()).toEqual([1, 3]);
  });

  it("supports $and / $or", async () => {
    const app = makeApp();
    const body = await (await query(app, {
      filter: { $or: [{ name: "alpha" }, { price: { $gt: 25 } }] },
    })).json();
    expect(body.data.map((r: MemoryNodeRow) => r.id).sort()).toEqual([1, 3]);
  });

  it("orders and projects fields", async () => {
    const app = makeApp();
    const body = await (await query(app, {
      order_by: [{ field: "price", dir: "desc" }], fields: ["id", "price"],
    })).json();
    expect(body.data[0]).toEqual({ id: 3, price: 30 });
    expect(body.data[2].id).toBe(1);
  });

  it("respects limit/offset", async () => {
    const app = makeApp();
    const body = await (await query(app, { limit: 1, offset: 1, order_by: [{ field: "id", dir: "asc" }] })).json();
    expect(body.count).toBe(1);
    expect(body.data[0].id).toBe(2);
  });

  it("unknown projected field → 400 FIELD-UNKNOWN", async () => {
    const app = makeApp();
    const r = await query(app, { fields: ["nope"] });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_QUERY_FIELD_UNKNOWN);
  });

  it("unsupported filter operator → 400 FILTER-INVALID", async () => {
    const app = makeApp();
    const r = await query(app, { filter: { price: { $weird: 1 } } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_QUERY_FILTER_INVALID);
  });
});

describe("memory-server: budget trimming", () => {
  it("trims rows to fit the X-NWP-Budget", async () => {
    const app = makeApp();
    const r = await query(app, {}, { "X-NWP-Budget": "1" });
    const body = await r.json();
    // Each row costs > 1 token, so trimming yields zero rows.
    expect(body.count).toBe(0);
    expect(body.token_est).toBe(0);
  });
});

describe("memory-server: auth & routing", () => {
  it("requireAuth rejects missing agent with 401", async () => {
    const app = makeApp(ROWS, { requireAuth: true });
    const r = await app.fetch(new Request(`http://memory${PREFIX}/.nwm`));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe(EC.NWP_AUTH_NID_SCOPE_VIOLATION);
  });

  it("GET /query → 405", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://memory${PREFIX}/query`));
    expect(r.status).toBe(405);
  });

  it("unknown path → 404", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://memory${PREFIX}/nope`));
    expect(r.status).toBe(404);
  });
});

describe("memory-server: stream (NDJSON)", () => {
  it("emits data chunk then is_last", async () => {
    const app = makeApp();
    const r = await app.fetch(new Request(`http://memory${PREFIX}/stream`, {
      method: "POST", body: JSON.stringify({ filter: { id: 1 } }),
    }));
    expect(r.status).toBe(200);
    const text = await r.text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].data[0].id).toBe(1);
    expect(lines[lines.length - 1].is_last).toBe(true);
  });
});
