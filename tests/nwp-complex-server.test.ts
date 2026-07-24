// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ComplexNodeApp,
  COMPLEX_ABSOLUTE_MAX_DEPTH,
  COMPLEX_TRACE_HEADER,
  NullComplexNodeProvider,
  type ComplexNodeOptions,
  type IComplexNodeProvider,
} from "../src/nwp/complex-server.js";
import type { MemoryNodeQueryResult } from "../src/nwp/memory-server.js";
import { QueryFrame } from "../src/nwp/frames.js";
import * as EC from "../src/nwp/nwp-error-codes.js";

const PREFIX = "/graph";
const NODE = "urn:nps:node:api.example.com:graph";

class RowProvider implements IComplexNodeProvider {
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async query(): Promise<MemoryNodeQueryResult> {
    return { rows: this.rows };
  }
  async execute(): Promise<never> {
    throw new Error("no actions");
  }
}

function baseOptions(over: Partial<ComplexNodeOptions> = {}): ComplexNodeOptions {
  return { nodeId: NODE, pathPrefix: PREFIX, rejectPrivateChildUrls: false, ...over };
}

function query(app: ComplexNodeApp, headers?: Record<string, string>, body: Record<string, unknown> = {}): Promise<Response> {
  return app.fetch(new Request(`http://complex${PREFIX}/query`, {
    method: "POST", headers, body: JSON.stringify(body),
  }));
}

describe("complex-server: manifest", () => {
  it("advertises graph refs and max_depth", async () => {
    const app = new ComplexNodeApp(new NullComplexNodeProvider(), baseOptions({
      graph: [{ rel: "user", nodeUrl: "https://api.example.com/users" }],
      graphMaxDepth: 3,
    }));
    const m = await (await app.fetch(new Request(`http://complex${PREFIX}/.nwm`))).json();
    expect(m.node_type).toBe("complex");
    expect(m.graph.refs[0]).toEqual({ rel: "user", node_url: "https://api.example.com/users" });
    expect(m.graph.max_depth).toBe(3);
    expect(m.capabilities.query).toBe(true);
  });

  it("graphMaxDepth above the absolute cap throws", () => {
    expect(() => new ComplexNodeApp(new NullComplexNodeProvider(),
      baseOptions({ graphMaxDepth: COMPLEX_ABSOLUTE_MAX_DEPTH + 1 }))).toThrow(/absolute cap/);
  });
});

describe("complex-server: local query", () => {
  it("returns local rows without graph when depth absent", async () => {
    const app = new ComplexNodeApp(new RowProvider([{ id: 1 }, { id: 2 }]), baseOptions());
    const r = await query(app);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/nwp-capsule");
    const body = await r.json();
    expect(body.count).toBe(2);
    expect(body.graph).toBeUndefined();
  });
});

describe("complex-server: depth validation", () => {
  it("depth > node max_depth → 400 DEPTH-EXCEEDED", async () => {
    const app = new ComplexNodeApp(new RowProvider([]), baseOptions({ graphMaxDepth: 1 }));
    const r = await query(app, { "X-NWP-Depth": "2" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_DEPTH_EXCEEDED);
  });

  it("non-integer depth → 400", async () => {
    const app = new ComplexNodeApp(new RowProvider([]), baseOptions());
    const r = await query(app, { "X-NWP-Depth": "abc" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_DEPTH_EXCEEDED);
  });
});

describe("complex-server: cycle detection", () => {
  it("self in the trace → 422 GRAPH-CYCLE", async () => {
    const app = new ComplexNodeApp(new RowProvider([]), baseOptions());
    const r = await query(app, { [COMPLEX_TRACE_HEADER]: `other-node,${NODE}` });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe(EC.NWP_GRAPH_CYCLE);
  });
});

describe("complex-server: graph expansion", () => {
  it("fetches child /query and embeds capsules under graph", async () => {
    const childUrl = "https://api.example.com/users";
    const childFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      expect(url).toBe(`${childUrl}/query`);
      // child echoes depth & trace so we can assert propagation
      const depth = new Headers(init?.headers).get("X-NWP-Depth");
      const trace = new Headers(init?.headers).get(COMPLEX_TRACE_HEADER);
      return new Response(JSON.stringify({ anchor_ref: "child:anchor", count: 1, data: [{ u: 1 }], _depth: depth, _trace: trace }), {
        status: 200, headers: { "content-type": "application/nwp-capsule" },
      });
    };
    const app = new ComplexNodeApp(new RowProvider([{ id: 1 }]),
      baseOptions({ graph: [{ rel: "user", nodeUrl: childUrl }], graphMaxDepth: 2 }),
      { childFetch });
    const r = await query(app, { "X-NWP-Depth": "1" });
    const body = await r.json();
    expect(Array.isArray(body.graph)).toBe(true);
    expect(body.graph[0].rel).toBe("user");
    expect(body.graph[0].data.data[0]).toEqual({ u: 1 });
    // child depth decremented to 0, trace carries this node
    expect(body.graph[0].data._depth).toBe("0");
    expect(body.graph[0].data._trace).toBe(NODE);
  });

  it("child SSRF rejection surfaces as a graph error (private host)", async () => {
    const childFetch: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    const app = new ComplexNodeApp(new RowProvider([]),
      baseOptions({
        rejectPrivateChildUrls: true,
        graph: [{ rel: "internal", nodeUrl: "https://127.0.0.1/svc" }],
      }),
      { childFetch });
    const r = await query(app, { "X-NWP-Depth": "1" });
    const body = await r.json();
    expect(body.graph[0].error.code).toBe(EC.NWP_AUTH_NID_SCOPE_VIOLATION);
    expect(body.graph[0].data).toBeUndefined();
  });

  it("child non-2xx becomes a NODE-UNAVAILABLE graph error", async () => {
    const childFetch: typeof fetch = async () =>
      new Response("boom", { status: 503 });
    const app = new ComplexNodeApp(new RowProvider([]),
      baseOptions({ graph: [{ rel: "user", nodeUrl: "https://api.example.com/users" }] }),
      { childFetch });
    const r = await query(app, { "X-NWP-Depth": "1" });
    const body = await r.json();
    expect(body.graph[0].error.code).toBe(EC.NWP_NODE_UNAVAILABLE);
  });
});

describe("complex-server: invoke", () => {
  it("async action rejected with 400", async () => {
    const app = new ComplexNodeApp(new RowProvider([]),
      baseOptions({ actions: { "do.thing": { async: true } } }));
    const r = await app.fetch(new Request(`http://complex${PREFIX}/invoke`, {
      method: "POST", body: JSON.stringify({ action_id: "do.thing", async: true }),
    }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("unknown action → 404", async () => {
    const app = new ComplexNodeApp(new RowProvider([]), baseOptions({ actions: {} }));
    const r = await app.fetch(new Request(`http://complex${PREFIX}/invoke`, {
      method: "POST", body: JSON.stringify({ action_id: "nope" }),
    }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_NOT_FOUND);
  });
});
