// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NPS-CR-0010 — inbound Bridge servers. Ports brief B Part 2 §8 (the six TC-N2-BridgeIn
// conformance cases) plus the .NET BridgeNodeTests / BridgeErrorMapTests scenarios listed
// under "".NET tests to mirror beyond the six".

import { describe, expect, it } from "vitest";

import { NpsStatusCodes } from "../src/core/status-codes.js";
import type { ErrorFrame } from "../src/ncp/frames/error-frame.js";
import {
  A2aInboundServer,
  BridgeErrorCodes,
  BridgeInboundApp,
  BridgeJsonRpcErrorCodes,
  GrpcInboundService,
  GrpcStatusError,
  HttpNwpBackend,
  InProcessNwpBackend,
  McpInboundServer,
  McpToolName,
  NwpNodeRole,
  RETIRED_TOOL_NOT_FOUND_CODE,
  createBridgeServerBackends,
  fromGrpcStatus,
  fromHttpStatus,
  fromJsonRpc,
  isValidAgentNid,
  mustBeProtocolError,
  parseNodeRole,
  toGrpcStatus,
  toJsonRpc,
  type BridgeInboundOptions,
  type BridgeJsonRpcResponse,
  type INwpBackend,
} from "../src/nwp/inbound/index.js";

const C = BridgeJsonRpcErrorCodes;
const S = NpsStatusCodes;
const NODE = "bridge-inbound-test";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function errorFrame(status: string, error: string, message?: string): ErrorFrame {
  return { frame: "0xFE", status, error, message };
}

/** The .NET fixture: one node exposing `orders.lookup`, dispatching to a CapsFrame-ish body. */
function actionOptions(over: Partial<BridgeInboundOptions> = {}): BridgeInboundOptions {
  return {
    nodeId: NODE,
    serverName: NODE,
    nodeRole: NwpNodeRole.ACTION,
    inboundProtocols: ["mcp", "a2a"],
    actions: [{ actionId: "orders.lookup", description: "Look an order up." }],
    dispatch: async (frame) => ({ anchor_ref: "nps:orders:v1", count: 1, data: [{ id: frame.actionId }] }),
    ...over,
  };
}

function servers(options: BridgeInboundOptions) {
  const backends = createBridgeServerBackends(options);
  return {
    backends,
    mcp: new McpInboundServer(options, backends),
    a2a: new A2aInboundServer(options, backends),
    grpc: new GrpcInboundService(options, backends),
  };
}

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function resultOf(r: BridgeJsonRpcResponse): Record<string, unknown> {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  return r.result as Record<string, unknown>;
}

// ── Tool-name encoding ───────────────────────────────────────────────────────

describe("McpToolName", () => {
  it("encodes node + action with __ and folds dots to underscores", () => {
    expect(McpToolName.encode(NODE, "orders.lookup")).toBe("bridge-inbound-test__orders_lookup");
    expect(McpToolName.encodeActionSegment("orders.lookup")).toBe("orders_lookup");
  });

  it("sanitises illegal characters and never yields an empty segment", () => {
    expect(McpToolName.encode("a b/c", "x")).toBe("a_b_c__x");
    expect(McpToolName.encode("", "")).toBe("node__node");
    expect(McpToolName.encode("__weird__", "y")).toBe("weird__y");
  });

  it("exposes no decode — the transform is deliberately lossy", () => {
    expect(McpToolName.encode("a", "b.c")).toBe(McpToolName.encode("a", "b_c"));
    expect((McpToolName as Record<string, unknown>)["decode"]).toBeUndefined();
  });
});

// ── TC-N2-BridgeIn-01 — MCP serves the full required method set ──────────────

describe("BridgeIn-01 — MCP inbound serves the full required method set", () => {
  const opts = actionOptions({ nodeRole: NwpNodeRole.COMPLEX, query: async () => ({ rows: [1, 2] }) });

  it("declares exactly the six normative methods as data", () => {
    expect(McpInboundServer.REQUIRED_METHODS).toEqual(
      ["initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/read"]);
  });

  it("all six return successful results", async () => {
    const { mcp } = servers(opts);
    for (const method of McpInboundServer.REQUIRED_METHODS) {
      const params =
        method === "tools/call" ? { name: "bridge-inbound-test__orders_lookup", arguments: {} }
        : method === "resources/read" ? { uri: `nwp://${NODE}/` }
        : undefined;
      const r = await mcp.dispatch(rpc(method, params));
      expect(r.error, `${method}: ${JSON.stringify(r.error)}`).toBeUndefined();
    }
  });

  it("initialize always advertises BOTH tools and resources capabilities", async () => {
    const { mcp } = servers(actionOptions());   // Action-only: no Memory Node behind it
    const res = resultOf(await mcp.dispatch(rpc("initialize")));
    expect(res["capabilities"]).toEqual({ tools: {}, resources: {} });
    expect(res["serverInfo"]).toMatchObject({ name: NODE });
  });

  it("tools/list surfaces qualified node__action names with an open schema fallback", async () => {
    const { mcp } = servers(opts);
    const tools = resultOf(await mcp.dispatch(rpc("tools/list")))["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0]["name"]).toBe("bridge-inbound-test__orders_lookup");
    expect(tools[0]["inputSchema"]).toEqual({ type: "object", additionalProperties: true });
  });

  it("tools/call dispatches an ActionFrame and reports isError: false", async () => {
    const { mcp } = servers(opts);
    const res = resultOf(await mcp.dispatch(
      rpc("tools/call", { name: "bridge-inbound-test__orders_lookup", arguments: { q: 1 } })));
    expect(res["isError"]).toBe(false);
    const content = res["content"] as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toMatchObject({ anchor_ref: "nps:orders:v1" });
  });

  it("resources/list projects a queryable node onto nwp://<node>/", async () => {
    const { mcp } = servers(opts);
    const resources = resultOf(await mcp.dispatch(rpc("resources/list")))["resources"] as Record<string, unknown>[];
    expect(resources).toHaveLength(1);
    expect(resources[0]["uri"]).toBe(`nwp://${NODE}/`);
    expect(resources[0]["mimeType"]).toBe("application/json");
    expect(resources[0]["description"]).toBe("NPS Bridge Node inbound surface.");
  });

  it("falls back to a generated resource description when the node declares none", async () => {
    const mcp = new McpInboundServer({ inboundProtocols: ["mcp"] }, [
      new InProcessNwpBackend({ name: "mem", role: NwpNodeRole.MEMORY }, [], undefined,
        async () => ({ rows: [] })),
    ]);
    const resources = resultOf(await mcp.dispatch(rpc("resources/list")))["resources"] as Record<string, unknown>[];
    expect(resources[0]["description"]).toBe("NWP memory Node 'mem' — read to query.");
    expect(resources[0]["name"]).toBe("mem");
  });

  it("serves resources/* over an EMPTY set when no Memory Node is behind it — still conformant", async () => {
    const { mcp } = servers(actionOptions());
    // The METHOD is served (§16.1.2 requires the method, not that a Memory Node exist).
    expect(resultOf(await mcp.dispatch(rpc("resources/list")))["resources"]).toEqual([]);
    // An unknown host is a bad ARGUMENT (-32602), not a missing method.
    const unknown = await mcp.dispatch(rpc("resources/read", { uri: "nwp://no-such-node/" }));
    expect(unknown.error?.code).toBe(C.INVALID_PARAMS);
    expect((unknown.error?.data as Record<string, unknown>)["error"])
      .toBe(BridgeErrorCodes.SERVER_TOOL_NOT_FOUND);
    // Reading a node that exists but is not queryable is NPS-SERVER-UNSUPPORTED ⇒ -32601;
    // the resourceRead flag only re-routes the CLIENT-NOT-FOUND row.
    const notQueryable = await mcp.dispatch(rpc("resources/read", { uri: `nwp://${NODE}/` }));
    expect(notQueryable.error?.code).toBe(C.METHOD_NOT_FOUND);
  });

  it("resources/read issues a limited query and returns the raw payload as text", async () => {
    let seenLimit: unknown;
    const { mcp } = servers(actionOptions({
      nodeRole: NwpNodeRole.MEMORY, resourceReadLimit: 42,
      query: async (frame) => { seenLimit = frame.filter?.["limit"]; return { rows: [] }; },
    }));
    const res = resultOf(await mcp.dispatch(rpc("resources/read", { uri: `nwp://${NODE}/` })));
    expect(seenLimit).toBe(42);
    const contents = res["contents"] as { uri: string; mimeType: string; text: string }[];
    expect(contents[0].uri).toBe(`nwp://${NODE}/`);
    expect(JSON.parse(contents[0].text)).toEqual({ rows: [] });
  });

  it("rejects a malformed resource URI and a missing uri param with -32602", async () => {
    const { mcp } = servers(actionOptions({ nodeRole: NwpNodeRole.MEMORY, query: async () => ({}) }));
    expect((await mcp.dispatch(rpc("resources/read", {}))).error?.code).toBe(C.INVALID_PARAMS);
    const bad = await mcp.dispatch(rpc("resources/read", { uri: "http://example.com/x" }));
    expect(bad.error?.code).toBe(C.INVALID_PARAMS);
    expect(bad.error?.message).toContain("nwp://<node>/");
  });

  it("an unknown method is -32601 with NWP-BRIDGE-DIRECTION-UNSUPPORTED", async () => {
    const { mcp } = servers(actionOptions());
    const r = await mcp.dispatch(rpc("tools/nope"));
    expect(r.error?.code).toBe(C.METHOD_NOT_FOUND);
    expect((r.error?.data as Record<string, unknown>)["error"]).toBe(BridgeErrorCodes.DIRECTION_UNSUPPORTED);
  });

  it("tools/call with a missing name is -32602", async () => {
    const { mcp } = servers(actionOptions());
    const r = await mcp.dispatch(rpc("tools/call", { arguments: {} }));
    expect(r.error?.code).toBe(C.INVALID_PARAMS);
    expect(r.error?.message).toBe("MCP tools/call requires params.name.");
  });
});

// ── MCP stdio transport ──────────────────────────────────────────────────────

describe("MCP stdio transport", () => {
  async function* lines(...ls: string[]) { for (const l of ls) yield l; }

  it("handles line-delimited JSON-RPC, skipping blank lines", async () => {
    const { mcp } = servers(actionOptions());
    const out: string[] = [];
    await mcp.runStdio(
      lines(JSON.stringify(rpc("ping")), "", "   ", JSON.stringify(rpc("initialize", undefined, 2))),
      (l) => { out.push(l); });
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.endsWith("\n"))).toBe(true);
    expect(JSON.parse(out[0])).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
    expect(JSON.parse(out[1])["id"]).toBe(2);
  });

  it("a non-envelope line is -32600 and unparseable JSON is -32700 with id: null", async () => {
    const { mcp } = servers(actionOptions());
    const out: string[] = [];
    await mcp.runStdio(lines('{"not":"a request"}', "{{{"), (l) => { out.push(l); });
    expect(JSON.parse(out[0])["error"]).toMatchObject({ code: C.INVALID_REQUEST });
    expect(JSON.parse(out[1])["error"]["code"]).toBe(C.PARSE_ERROR);
    expect(JSON.parse(out[1])["id"]).toBeNull();
  });
});

// ── TC-N2-BridgeIn-03 — A2A round-trip ───────────────────────────────────────

describe("BridgeIn-03 — A2A inbound round-trip", () => {
  it("the AgentCard lists fronted actions as skills with qualified ids", async () => {
    const { a2a } = servers(actionOptions());
    const card = await a2a.buildAgentCard("https://bridge.test/a2a");
    expect(card.url).toBe("https://bridge.test/a2a");
    expect(card.provider).toEqual({
      organization: "LabAcacia / INNO LOTUS PTY LTD",
      url: "https://github.com/labacacia/nps",
    });
    expect(card.capabilities).toEqual(
      { streaming: false, pushNotifications: false, stateTransitionHistory: false });
    expect(card.authentication).toEqual({ schemes: ["apikey"], credentials: "X-NWP-Agent" });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]).toMatchObject({
      id: "bridge-inbound-test__orders_lookup",
      name: "Look an order up.",
      inputModes: ["text", "data"],
      outputModes: ["data"],
    });
  });

  it("omits AgentCard authentication when auth is not required", async () => {
    const { a2a } = servers(actionOptions({ requireAuth: false }));
    expect((await a2a.buildAgentCard("u")).authentication).toBeNull();
  });

  it("tasks/send completes and returns the action result as the task artifact", async () => {
    const { a2a } = servers(actionOptions());
    const res = resultOf(await a2a.dispatch(rpc("tasks/send", {
      id: "task-1",
      sessionId: "sess-1",
      message: { role: "user", parts: [{ type: "data", data: { q: 1 } }] },
      metadata: { action_id: "orders.lookup" },
    })));
    expect((res["status"] as Record<string, unknown>)["state"]).toBe("completed");
    expect((res["status"] as Record<string, unknown>)["message"]).toBeNull();
    const artifacts = res["artifacts"] as Record<string, unknown>[];
    expect(artifacts[0]["name"]).toBe("nps-result");
    expect(artifacts[0]["index"]).toBe(0);
    const parts = artifacts[0]["parts"] as { type: string; data: Record<string, unknown> }[];
    expect(parts[0].type).toBe("data");
    expect(parts[0].data["anchor_ref"]).toBe("nps:orders:v1");
    expect(res["id"]).toBe("task-1");
    expect(res["sessionId"]).toBe("sess-1");
    expect(res["history"]).toHaveLength(1);
  });

  it("resolves a skill by qualified id, by raw action id, and from part metadata/data", async () => {
    const { a2a } = servers(actionOptions());
    const send = (metadata: unknown, parts: unknown[] = []) => a2a.dispatch(rpc("tasks/send", {
      id: "t", message: { role: "user", parts }, metadata,
    }));
    expect(resultOf(await send({ skill: "bridge-inbound-test__orders_lookup" }))["status"])
      .toMatchObject({ state: "completed" });
    expect(resultOf(await send({ actionId: "orders.lookup" }))["status"])
      .toMatchObject({ state: "completed" });
    expect(resultOf(await send(undefined, [{ type: "data", data: { skill_id: "orders.lookup" } }]))["status"])
      .toMatchObject({ state: "completed" });
  });

  it("extracts arguments from metadata.params, part.data.arguments, a data part, then a text part", async () => {
    const seen: unknown[] = [];
    const opts = actionOptions({ dispatch: async (f) => { seen.push(f.params); return { ok: true }; } });
    const { a2a } = servers(opts);
    const send = (params: Record<string, unknown>) => a2a.dispatch(rpc("tasks/send", params));

    await send({ id: "t", message: { role: "user", parts: [] }, metadata: { params: { a: 1 } } });
    await send({ id: "t", message: { role: "user", parts: [{ type: "data", data: { arguments: { b: 2 } } }] } });
    await send({ id: "t", message: { role: "user", parts: [{ type: "data", data: { c: 3 } }] } });
    await send({ id: "t", message: { role: "user", parts: [{ type: "text", text: "hi" }] } });
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { text: "hi" }]);
  });

  it("serves only tasks/send — anything else is -32601 DIRECTION-UNSUPPORTED", async () => {
    const { a2a } = servers(actionOptions());
    const r = await a2a.dispatch(rpc("tasks/get", { id: "t" }));
    expect(r.error?.code).toBe(C.METHOD_NOT_FOUND);
    expect((r.error?.data as Record<string, unknown>)["error"]).toBe(BridgeErrorCodes.DIRECTION_UNSUPPORTED);
  });

  it("requires params.id", async () => {
    const { a2a } = servers(actionOptions());
    const r = await a2a.dispatch(rpc("tasks/send", { message: { role: "user", parts: [] } }));
    expect(r.error?.code).toBe(C.INVALID_PARAMS);
    expect(r.error?.message).toBe("A2A tasks/send params.id is required.");
  });

  it("a domain failure terminates the task as failed with the NPS code preserved verbatim", async () => {
    const { a2a } = servers(actionOptions({
      dispatch: async () => errorFrame(S.NPS_CLIENT_UNPROCESSABLE, "NWP-ACTION-PARAMS-INVALID", "bad params"),
    }));
    const res = resultOf(await a2a.dispatch(rpc("tasks/send", {
      id: "t", message: { role: "user", parts: [] },
    })));
    const status = res["status"] as Record<string, unknown>;
    expect(status["state"]).toBe("failed");
    const msg = status["message"] as { role: string; parts: { text: string }[] };
    expect(msg.role).toBe("agent");
    expect(msg.parts[0].text).toBe("bad params");
    const artifacts = res["artifacts"] as Record<string, unknown>[];
    expect(artifacts[0]["name"]).toBe("nps-error");
    expect((artifacts[0]["parts"] as { data: Record<string, unknown> }[])[0].data).toMatchObject({
      status: S.NPS_CLIENT_UNPROCESSABLE, error: "NWP-ACTION-PARAMS-INVALID",
    });
  });

  it("an infrastructure failure becomes a JSON-RPC error, NOT a failed task", async () => {
    const { a2a } = servers(actionOptions({
      dispatch: async () => errorFrame(S.NPS_AUTH_FORBIDDEN, "NWP-AUTH-NID-SCOPE-VIOLATION", "nope"),
    }));
    const r = await a2a.dispatch(rpc("tasks/send", { id: "t", message: { role: "user", parts: [] } }));
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(C.FORBIDDEN);
  });
});

// ── TC-N2-BridgeIn-04 — bare id resolves, ambiguity is rejected ──────────────

describe("BridgeIn-04 — bare action id resolves while ambiguity is rejected", () => {
  /** Two nodes: exactly one defines `orders_lookup`, both define `status`. */
  function twoNodes() {
    const backends: INwpBackend[] = [
      new InProcessNwpBackend(
        { name: "node-a", role: NwpNodeRole.ACTION },
        [{ actionId: "orders_lookup" }, { actionId: "status" }],
        async (f) => ({ from: "node-a", action: f.actionId }),
      ),
      new InProcessNwpBackend(
        { name: "node-b", role: NwpNodeRole.ACTION },
        [{ actionId: "status" }],
        async (f) => ({ from: "node-b", action: f.actionId }),
      ),
    ];
    return new McpInboundServer({ inboundProtocols: ["mcp"] }, backends);
  }

  it("a bare unambiguous action id resolves and succeeds", async () => {
    const res = resultOf(await twoNodes().dispatch(rpc("tools/call", { name: "orders_lookup" })));
    expect(res["isError"]).toBe(false);
    expect(JSON.parse((res["content"] as { text: string }[])[0].text)).toEqual(
      { from: "node-a", action: "orders_lookup" });
  });

  it("a bare AMBIGUOUS action id is rejected deterministically, naming both qualified candidates", async () => {
    const r = await twoNodes().dispatch(rpc("tools/call", { name: "status" }));
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(C.METHOD_NOT_FOUND);
    const data = r.error?.data as Record<string, unknown>;
    expect(data["error"]).toBe(BridgeErrorCodes.SERVER_TOOL_NOT_FOUND);
    expect(data["candidates"]).toEqual(["node-a__status", "node-b__status"]);
  });

  it("the qualified form still resolves each candidate unambiguously", async () => {
    const a = resultOf(await twoNodes().dispatch(rpc("tools/call", { name: "node-a__status" })));
    const b = resultOf(await twoNodes().dispatch(rpc("tools/call", { name: "node-b__status" })));
    expect(JSON.parse((a["content"] as { text: string }[])[0].text)["from"]).toBe("node-a");
    expect(JSON.parse((b["content"] as { text: string }[])[0].text)["from"]).toBe("node-b");
  });

  it("resolves the dotted bare form too (orders_lookup ⇒ action id orders.lookup)", async () => {
    const { mcp } = servers(actionOptions());
    expect(resultOf(await mcp.dispatch(rpc("tools/call", { name: "orders_lookup" })))["isError"]).toBe(false);
  });

  it("an entirely unknown tool is -32601, never the retired -32002", async () => {
    const { mcp } = servers(actionOptions());
    const r = await mcp.dispatch(rpc("tools/call", { name: "nope" }));
    expect(r.error?.code).toBe(C.METHOD_NOT_FOUND);
    expect(r.error?.code).not.toBe(RETIRED_TOOL_NOT_FOUND_CODE);
    expect(r.error?.message).toBe("MCP tool 'nope' is not exposed by this Bridge Node.");
  });

  it("A2A with no skill named succeeds only when exactly one action is exposed in total", async () => {
    const single = new A2aInboundServer({ inboundProtocols: ["a2a"] }, [
      new InProcessNwpBackend({ name: "n", role: NwpNodeRole.ACTION }, [{ actionId: "only" }],
        async () => ({ ok: true })),
    ]);
    expect(resultOf(await single.dispatch(rpc("tasks/send", {
      id: "t", message: { role: "user", parts: [] },
    })))["status"]).toMatchObject({ state: "completed" });

    const many = new A2aInboundServer({ inboundProtocols: ["a2a"] }, [
      new InProcessNwpBackend({ name: "n", role: NwpNodeRole.ACTION },
        [{ actionId: "a" }, { actionId: "b" }], async () => ({ ok: true })),
    ]);
    const r = await many.dispatch(rpc("tasks/send", { id: "t", message: { role: "user", parts: [] } }));
    expect(r.error?.code).toBe(C.INVALID_PARAMS);
    expect((r.error?.data as Record<string, unknown>)["error"]).toBe(BridgeErrorCodes.SERVER_TOOL_NOT_FOUND);
  });
});

// ── TC-N2-BridgeIn-05 — error mapping matches the §16.3 table ────────────────

describe("BridgeIn-05 — error mapping (NWP §16.3)", () => {
  it("maps every ToJsonRpc row", () => {
    expect(toJsonRpc(S.NPS_CLIENT_BAD_FRAME)).toBe(-32600);
    expect(toJsonRpc(S.NPS_CLIENT_BAD_PARAM)).toBe(-32602);
    expect(toJsonRpc(S.NPS_CLIENT_UNPROCESSABLE)).toBe(-32602);
    expect(toJsonRpc(S.NPS_CLIENT_GONE)).toBe(-32602);
    expect(toJsonRpc(S.NPS_CLIENT_CONFLICT)).toBe(-32004);
    expect(toJsonRpc(S.NPS_AUTH_UNAUTHENTICATED)).toBe(-32001);
    expect(toJsonRpc(S.NPS_AUTH_FORBIDDEN)).toBe(-32003);
    expect(toJsonRpc(S.NPS_LIMIT_RATE)).toBe(-32005);
    expect(toJsonRpc(S.NPS_LIMIT_BUDGET)).toBe(-32005);
    expect(toJsonRpc(S.NPS_LIMIT_PAYLOAD)).toBe(-32005);
    expect(toJsonRpc(S.NPS_SERVER_UNSUPPORTED)).toBe(-32601);
    for (const s of [S.NPS_SERVER_INTERNAL, S.NPS_SERVER_UNAVAILABLE, S.NPS_SERVER_TIMEOUT,
      S.NPS_DOWNSTREAM_UNAVAILABLE]) {
      expect(toJsonRpc(s)).toBe(-32603);
    }
    expect(toJsonRpc("NPS-SOMETHING-ELSE")).toBe(-32603);
  });

  it("distinguishes an unknown TOOL (-32601) from an unknown URI (-32602)", () => {
    expect(toJsonRpc(S.NPS_CLIENT_NOT_FOUND)).toBe(-32601);
    expect(toJsonRpc(S.NPS_CLIENT_NOT_FOUND, true)).toBe(-32602);
  });

  it("does not collapse the auth classes onto one another", () => {
    expect(toJsonRpc(S.NPS_AUTH_UNAUTHENTICATED)).not.toBe(toJsonRpc(S.NPS_AUTH_FORBIDDEN));
    expect(toGrpcStatus(S.NPS_AUTH_UNAUTHENTICATED)).toBe("UNAUTHENTICATED");
    expect(toGrpcStatus(S.NPS_AUTH_FORBIDDEN)).toBe("PERMISSION_DENIED");
  });

  it("does not collapse every server class onto UNAVAILABLE", () => {
    expect(toGrpcStatus(S.NPS_SERVER_INTERNAL)).toBe("INTERNAL");
    expect(toGrpcStatus(S.NPS_SERVER_UNAVAILABLE)).toBe("UNAVAILABLE");
    expect(toGrpcStatus(S.NPS_SERVER_TIMEOUT)).toBe("DEADLINE_EXCEEDED");
    expect(toGrpcStatus(S.NPS_SERVER_UNSUPPORTED)).toBe("UNIMPLEMENTED");
    expect(toGrpcStatus(S.NPS_DOWNSTREAM_UNAVAILABLE)).toBe("UNAVAILABLE");
  });

  it("maps the FromHttpStatus rows, never a blanket NPS-SERVER-INTERNAL", () => {
    const rows: [number, string][] = [
      [400, S.NPS_CLIENT_BAD_PARAM], [401, S.NPS_AUTH_UNAUTHENTICATED], [403, S.NPS_AUTH_FORBIDDEN],
      [404, S.NPS_CLIENT_NOT_FOUND], [408, S.NPS_SERVER_TIMEOUT], [409, S.NPS_CLIENT_CONFLICT],
      [410, S.NPS_CLIENT_GONE], [413, S.NPS_LIMIT_PAYLOAD], [415, S.NPS_SERVER_ENCODING_UNSUPPORTED],
      [422, S.NPS_CLIENT_UNPROCESSABLE], [429, S.NPS_LIMIT_RATE], [501, S.NPS_SERVER_UNSUPPORTED],
      [502, S.NPS_DOWNSTREAM_UNAVAILABLE], [503, S.NPS_SERVER_UNAVAILABLE],
      [504, S.NPS_DOWNSTREAM_UNAVAILABLE], [500, S.NPS_SERVER_INTERNAL],
      [418, S.NPS_CLIENT_BAD_PARAM], [204, S.NPS_OK],
    ];
    for (const [http, nps] of rows) expect(fromHttpStatus(http), `HTTP ${http}`).toBe(nps);
  });

  it("maps the FromJsonRpc and FromGrpcStatus inverses", () => {
    expect(fromJsonRpc(-32700)).toBe(S.NPS_CLIENT_BAD_FRAME);
    expect(fromJsonRpc(-32600)).toBe(S.NPS_CLIENT_BAD_FRAME);
    expect(fromJsonRpc(-32601)).toBe(S.NPS_CLIENT_NOT_FOUND);
    expect(fromJsonRpc(-32602)).toBe(S.NPS_CLIENT_BAD_PARAM);
    expect(fromJsonRpc(-32603)).toBe(S.NPS_SERVER_INTERNAL);
    expect(fromJsonRpc(-32001)).toBe(S.NPS_AUTH_UNAUTHENTICATED);
    expect(fromJsonRpc(-32003)).toBe(S.NPS_AUTH_FORBIDDEN);
    expect(fromJsonRpc(-32004)).toBe(S.NPS_CLIENT_CONFLICT);
    expect(fromJsonRpc(-32005)).toBe(S.NPS_LIMIT_RATE);
    expect(fromJsonRpc(-32000)).toBe(S.NPS_DOWNSTREAM_UNAVAILABLE);
    expect(fromJsonRpc(-1)).toBe(S.NPS_SERVER_INTERNAL);

    expect(fromGrpcStatus("OK")).toBe(S.NPS_OK);
    expect(fromGrpcStatus("FAILED_PRECONDITION")).toBe(S.NPS_CLIENT_UNPROCESSABLE);
    expect(fromGrpcStatus("ALREADY_EXISTS")).toBe(S.NPS_CLIENT_CONFLICT);
    expect(fromGrpcStatus("ABORTED")).toBe(S.NPS_CLIENT_CONFLICT);
    expect(fromGrpcStatus("DATA_LOSS")).toBe(S.NPS_SERVER_INTERNAL);
    expect(fromGrpcStatus(undefined)).toBe(S.NPS_SERVER_INTERNAL);
  });

  it("MustBeProtocolError covers exactly the infrastructure classes", () => {
    for (const s of [S.NPS_AUTH_UNAUTHENTICATED, S.NPS_AUTH_FORBIDDEN, S.NPS_LIMIT_RATE,
      S.NPS_LIMIT_BUDGET, S.NPS_LIMIT_PAYLOAD, S.NPS_SERVER_UNSUPPORTED, S.NPS_SERVER_INTERNAL,
      S.NPS_SERVER_UNAVAILABLE, S.NPS_SERVER_TIMEOUT, S.NPS_DOWNSTREAM_UNAVAILABLE]) {
      expect(mustBeProtocolError(s), s).toBe(true);
    }
    for (const s of [S.NPS_CLIENT_BAD_FRAME, S.NPS_CLIENT_BAD_PARAM, S.NPS_CLIENT_NOT_FOUND,
      S.NPS_CLIENT_CONFLICT, S.NPS_CLIENT_GONE, S.NPS_CLIENT_UNPROCESSABLE, S.NPS_OK, undefined]) {
      expect(mustBeProtocolError(s), String(s)).toBe(false);
    }
  });

  it("an auth failure is a protocol error, NOT an isError result", async () => {
    const { mcp } = servers(actionOptions({
      dispatch: async () => errorFrame(S.NPS_AUTH_FORBIDDEN, "NWP-AUTH-NID-SCOPE-VIOLATION", "denied"),
    }));
    const r = await mcp.dispatch(rpc("tools/call", { name: "orders_lookup" }));
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(-32003);
    expect((r.error?.data as Record<string, unknown>)["status"]).toBe(S.NPS_AUTH_FORBIDDEN);
  });

  it("a tool-domain failure stays an isError:true result", async () => {
    const { mcp } = servers(actionOptions({
      dispatch: async () => errorFrame(S.NPS_CLIENT_UNPROCESSABLE, "NWP-ACTION-PARAMS-INVALID", "bad"),
    }));
    const res = resultOf(await mcp.dispatch(rpc("tools/call", { name: "orders_lookup" })));
    expect(res["isError"]).toBe(true);
    expect(JSON.parse((res["content"] as { text: string }[])[0].text)).toEqual({
      status: S.NPS_CLIENT_UNPROCESSABLE, error: "NWP-ACTION-PARAMS-INVALID", message: "bad",
    });
  });

  it("a missing dispatcher fails loudly with -32603 and the registered code", async () => {
    // Actions declared but no dispatcher: the backend is still created deliberately.
    const { mcp, backends } = servers({
      nodeId: NODE, inboundProtocols: ["mcp"],
      actions: [{ actionId: "orders.lookup" }],
    });
    expect(backends).toHaveLength(1);
    const r = await mcp.dispatch(rpc("tools/call", { name: "orders_lookup" }));
    expect(r.error?.code).toBe(C.INTERNAL_ERROR);
    const data = JSON.stringify(r.error?.data);
    expect(data).toContain(BridgeErrorCodes.SERVER_DISPATCHER_MISSING);
    expect(data).not.toContain("NPS-SERVER-NOT-IMPLEMENTED");
  });

  it("a thrown dispatcher becomes NWP-BRIDGE-SERVER-DISPATCH-FAILED", async () => {
    const { mcp } = servers(actionOptions({
      dispatch: async () => { throw new Error("kaboom"); },
    }));
    const r = await mcp.dispatch(rpc("tools/call", { name: "orders_lookup" }));
    expect(r.error?.code).toBe(C.INTERNAL_ERROR);
    expect(JSON.stringify(r.error?.data)).toContain(BridgeErrorCodes.SERVER_DISPATCH_FAILED);
  });
});

// ── TC-N2-BridgeIn-06 — undeclared protocol / direction ─────────────────────

describe("BridgeIn-06 — undeclared protocol/direction is refused", () => {
  it("a well-formed A2A tasks/send on an MCP-only Bridge is refused", async () => {
    const { a2a } = servers(actionOptions({ inboundProtocols: ["mcp"], outboundProtocols: ["http"] }));
    const r = await a2a.dispatch(rpc("tasks/send", { id: "t", message: { role: "user", parts: [] } }));
    expect(r.error?.code).toBe(C.METHOD_NOT_FOUND);   // NPS-SERVER-UNSUPPORTED ⇒ -32601
    const data = r.error?.data as Record<string, unknown>;
    expect(data["error"]).toBe(BridgeErrorCodes.DIRECTION_UNSUPPORTED);
    expect(r.error?.message).toContain('does not declare "a2a"');
    // SHOULD-clause: the response carries both declared arrays in `hint`.
    expect(data["hint"]).toEqual({ bridge_inbound_protocols: ["mcp"], bridge_protocols: ["http"] });
  });

  it("an MCP request on an A2A-only Bridge is refused the same way", async () => {
    const { mcp } = servers(actionOptions({ inboundProtocols: ["a2a"] }));
    const r = await mcp.dispatch(rpc("tools/list"));
    expect((r.error?.data as Record<string, unknown>)["error"]).toBe(BridgeErrorCodes.DIRECTION_UNSUPPORTED);
    expect(r.error?.message).toContain('does not declare "mcp"');
  });

  it("gRPC is NOT in the default inbound set, so the service refuses until 'grpc' is added", async () => {
    const { grpc } = servers(actionOptions());   // default ["mcp","a2a"]
    await expect(grpc.listActions({})).rejects.toThrow(GrpcStatusError);
    try { await grpc.listActions({}); } catch (e) {
      expect((e as GrpcStatusError).code).toBe("UNIMPLEMENTED");
      expect((e as GrpcStatusError).details).toContain(BridgeErrorCodes.DIRECTION_UNSUPPORTED);
    }
  });

  it("membership is case-insensitive", async () => {
    const { mcp } = servers(actionOptions({ inboundProtocols: ["MCP"] }));
    expect((await mcp.dispatch(rpc("ping"))).error).toBeUndefined();
  });
});

// ── TC-N2-BridgeIn-02 — gRPC service logic ──────────────────────────────────

describe("BridgeIn-02 — gRPC inbound service logic", () => {
  const opts = actionOptions({
    inboundProtocols: ["grpc"], nodeRole: NwpNodeRole.COMPLEX,
    query: async () => ({ rows: [{ n: 1 }] }),
  });

  it("Invoke returns http_status 200 and the node's NWP result body", async () => {
    const { grpc } = servers(opts);
    const res = await grpc.invoke({ action_id: "orders.lookup", params_json: '{"q":1}' });
    expect(res.http_status).toBe(200);
    expect(JSON.parse(res.body_json)).toMatchObject({ anchor_ref: "nps:orders:v1" });
    expect(res.task_id).toBe("");
  });

  it("lifts task_id out of the payload when present", async () => {
    const { grpc } = servers(actionOptions({
      inboundProtocols: ["grpc"], dispatch: async () => ({ task_id: "t-9" }),
    }));
    expect((await grpc.invoke({ action_id: "orders.lookup" })).task_id).toBe("t-9");
  });

  it("rejects an empty action_id with INVALID_ARGUMENT", async () => {
    const { grpc } = servers(opts);
    await expect(grpc.invoke({ action_id: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT", details: "action_id is required",
    });
  });

  it("GetManifest returns the NWM and the node_type (empty when Unknown)", async () => {
    const { grpc } = servers(opts);
    const res = await grpc.getManifest({});
    expect(res.node_type).toBe("complex");
    expect(JSON.parse(res.nwm_json)).toMatchObject({ node_type: "complex" });
  });

  it("ListActions returns the { actions: { id: { description } } } shape", async () => {
    const { grpc } = servers(opts);
    expect(JSON.parse((await grpc.listActions({})).actions_json)).toEqual({
      actions: { "orders.lookup": { description: "Look an order up." } },
    });
  });

  it("Query defaults an empty query_json to {}", async () => {
    let seen: unknown;
    const { grpc } = servers(actionOptions({
      inboundProtocols: ["grpc"], nodeRole: NwpNodeRole.MEMORY,
      query: async (f) => { seen = f.filter; return { rows: [] }; },
    }));
    const res = await grpc.query({});
    expect(res.http_status).toBe(200);
    expect(seen).toEqual({});
  });

  it("resolves the single backend when ctx.upstream is empty, and by name otherwise", async () => {
    const backends = [
      new InProcessNwpBackend({ name: "one", role: NwpNodeRole.ACTION }, [{ actionId: "x" }],
        async () => ({ n: 1 })),
      new InProcessNwpBackend({ name: "two", role: NwpNodeRole.ACTION }, [{ actionId: "x" }],
        async () => ({ n: 2 })),
    ];
    const svc = new GrpcInboundService({ inboundProtocols: ["grpc"] }, backends);
    expect(JSON.parse((await svc.invoke({ ctx: { upstream: "TWO" }, action_id: "x" })).body_json))
      .toEqual({ n: 2 });
    await expect(svc.invoke({ action_id: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const single = new GrpcInboundService({ inboundProtocols: ["grpc"] }, [backends[0]!]);
    expect(JSON.parse((await single.invoke({ action_id: "x" })).body_json)).toEqual({ n: 1 });
  });

  it("an unknown upstream is NOT_FOUND with the NPS status and NWP code in the detail", async () => {
    const { grpc } = servers(opts);
    try {
      await grpc.invoke({ ctx: { upstream: "nope" }, action_id: "orders.lookup" });
      expect.unreachable();
    } catch (e) {
      const err = e as GrpcStatusError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.details).toContain(S.NPS_CLIENT_NOT_FOUND);
      expect(err.details).toContain(BridgeErrorCodes.SERVER_TOOL_NOT_FOUND);
    }
  });

  it("surfaces a failure through the shared §16.3 table, keeping the exact NPS fault recoverable", async () => {
    const { grpc } = servers(actionOptions({
      inboundProtocols: ["grpc"],
      dispatch: async () => errorFrame(S.NPS_AUTH_FORBIDDEN, "NWP-AUTH-NID-SCOPE-VIOLATION", "denied"),
    }));
    try {
      await grpc.invoke({ action_id: "orders.lookup" });
      expect.unreachable();
    } catch (e) {
      const err = e as GrpcStatusError;
      // The old ingress collapsed 401 and 403 both onto PERMISSION_DENIED and every 5xx onto
      // UNAVAILABLE; §16.3 forbids collapsing distinct NPS status classes.
      expect(err.code).toBe("PERMISSION_DENIED");
      expect(err.details).toBe("NPS-AUTH-FORBIDDEN NWP-AUTH-NID-SCOPE-VIOLATION: denied");
    }
  });
});

// ── Backend abstraction ──────────────────────────────────────────────────────

describe("The backend abstraction", () => {
  it("parses NWM node_type into a role, defaulting to Unknown", () => {
    expect(parseNodeRole("memory")).toBe(NwpNodeRole.MEMORY);
    expect(parseNodeRole("ACTION")).toBe(NwpNodeRole.ACTION);
    expect(parseNodeRole("complex")).toBe(NwpNodeRole.COMPLEX);
    expect(parseNodeRole("anchor")).toBe(NwpNodeRole.ANCHOR);
    expect(parseNodeRole("bridge")).toBe(NwpNodeRole.BRIDGE);
    expect(parseNodeRole("nonsense")).toBe(NwpNodeRole.UNKNOWN);
    expect(parseNodeRole(undefined)).toBe(NwpNodeRole.UNKNOWN);
  });

  it("in-process: getActions is empty for a non-invokable node", async () => {
    const b = new InProcessNwpBackend({ name: "m", role: NwpNodeRole.MEMORY },
      [{ actionId: "x" }], async () => ({}), async () => ({ rows: [] }));
    expect(await b.getActions()).toEqual([]);
  });

  it("in-process: query on a non-queryable node is SERVER-UNSUPPORTED / TOOL-NOT-FOUND", async () => {
    const b = new InProcessNwpBackend({ name: "a", role: NwpNodeRole.ACTION });
    const r = await b.query({});
    expect(r).toMatchObject({
      ok: false, npsStatus: S.NPS_SERVER_UNSUPPORTED, nwpError: BridgeErrorCodes.SERVER_TOOL_NOT_FOUND,
    });
    expect(r.message).toContain("is not queryable");
  });

  it("in-process: synthesises a manifest from the descriptor", async () => {
    const b = new InProcessNwpBackend(
      { name: "n", role: NwpNodeRole.COMPLEX, displayName: "N", description: "d" });
    expect((await b.getManifest()).payload).toEqual(
      { node_type: "complex", display_name: "N", description: "d" });
  });

  it("http: an unreachable /.nwm caches role Unknown rather than taking the Bridge down", async () => {
    let calls = 0;
    const b = new HttpNwpBackend({ name: "up", baseUrl: "http://x" }, async () => {
      calls++; throw new Error("ECONNREFUSED");
    });
    expect((await b.getDescriptor()).role).toBe(NwpNodeRole.UNKNOWN);
    await b.getDescriptor();
    expect(calls).toBe(1);                                       // cached
  });

  it("http: translates a non-2xx upstream response through FromHttpStatus", async () => {
    const b = new HttpNwpBackend({ name: "up", baseUrl: "http://x" }, async (url) =>
      url.endsWith("/.nwm")
        ? new Response(JSON.stringify({ node_type: "action" }), { status: 200 })
        : new Response(JSON.stringify({ error: "NWP-AUTH-NID-EXPIRED" }), { status: 403 }));
    const r = await b.invoke("a", null, false);
    expect(r).toMatchObject({ ok: false, npsStatus: S.NPS_AUTH_FORBIDDEN, nwpError: "NWP-AUTH-NID-EXPIRED" });
  });

  it("http: consumes the { actions: { id: { description, params_schema } } } shape", async () => {
    const b = new HttpNwpBackend({ name: "up", baseUrl: "http://x" }, async (url) =>
      url.endsWith("/.nwm")
        ? new Response(JSON.stringify({ node_type: "action" }), { status: 200 })
        : new Response(JSON.stringify({
            actions: { "a.b": { description: "d", params_schema: { type: "object" } } },
          }), { status: 200 }));
    expect(await b.getActions()).toEqual([
      { actionId: "a.b", description: "d", inputSchema: { type: "object" } },
    ]);
  });

  it("http: a non-JSON 2xx body is DOWNSTREAM-UNAVAILABLE / UPSTREAM-FAILED", async () => {
    const b = new HttpNwpBackend({ name: "up", baseUrl: "http://x" }, async () =>
      new Response("<html/>", { status: 200 }));
    expect(await b.getManifest()).toMatchObject({
      ok: false, npsStatus: S.NPS_DOWNSTREAM_UNAVAILABLE, nwpError: BridgeErrorCodes.UPSTREAM_FAILED,
    });
  });

  it("materialisation: both shapes may coexist in one Bridge", () => {
    const backends = createBridgeServerBackends({
      nodeId: "local", actions: [{ actionId: "x" }],
      upstreams: [{ name: "remote", baseUrl: "http://r" }],
    }, async () => new Response("{}"));
    expect(backends).toHaveLength(2);
    expect(backends[0]).toBeInstanceOf(InProcessNwpBackend);
    expect(backends[1]).toBeInstanceOf(HttpNwpBackend);
  });

  it("materialisation: no in-process backend when nothing is declared", () => {
    expect(createBridgeServerBackends({})).toHaveLength(0);
  });
});

// ── Hosting layer (security defaults) ────────────────────────────────────────

describe("BridgeInboundApp hosting layer", () => {
  const AGENT = "urn:nps:agent:example.com:caller-1";

  function app(over: Parameters<typeof BridgeInboundApp.prototype.constructor>[0] = {}) {
    return new BridgeInboundApp({ ...actionOptions(), verifyAgent: () => true, ...over });
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://bridge.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-NWP-Agent": AGENT, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("validates the caller NID syntactically", () => {
    expect(isValidAgentNid(AGENT)).toBe(true);
    expect(isValidAgentNid("urn:nps:agent:example.com:a/b~c@d")).toBe(true);
    expect(isValidAgentNid("urn:nps:node:example.com:x")).toBe(false);
    expect(isValidAgentNid("urn:nps:agent:example.com")).toBe(false);
    expect(isValidAgentNid("urn:nps:agent::x")).toBe(false);
    expect(isValidAgentNid("urn:nps:agent:example.com:")).toBe(false);
    expect(isValidAgentNid("urn:nps:agent:ex ample:x")).toBe(false);
    expect(isValidAgentNid("urn:nps:agent:e:" + "x".repeat(600))).toBe(false);
  });

  it("401s on a missing header, an invalid NID, and a rejecting verifier", async () => {
    const a = app();
    const missing = await a.fetch(new Request("http://bridge.test/mcp", {
      method: "POST", body: "{}",
    }));
    expect(missing.status).toBe(401);
    expect((await missing.json() as BridgeJsonRpcResponse).error?.code).toBe(C.INVALID_REQUEST);

    expect((await a.fetch(post("/mcp", rpc("ping"), { "X-NWP-Agent": "bogus" }))).status).toBe(401);

    const rejecting = app({ verifyAgent: () => false });
    expect((await rejecting.fetch(post("/mcp", rpc("ping")))).status).toBe(401);
  });

  it("fails closed when auth is required but no verifier is configured", async () => {
    const a = new BridgeInboundApp(actionOptions());
    expect((await a.fetch(post("/mcp", rpc("ping")))).status).toBe(401);
  });

  it("serves /mcp, /mcp/sse and /a2a on POST, and 405s other methods", async () => {
    const a = app();
    for (const path of ["/mcp", "/mcp/sse", "/a2a"]) {
      const headers = { "content-type": "application/json", "X-NWP-Agent": AGENT };
      const body = path === "/a2a"
        ? rpc("tasks/send", { id: "t", message: { role: "user", parts: [] } })
        : rpc("ping");
      const res = await a.fetch(new Request(`http://bridge.test${path}`,
        { method: "POST", headers, body: JSON.stringify(body) }));
      expect(res.status, path).toBe(200);
    }
    expect((await a.fetch(new Request("http://bridge.test/mcp"))).status).toBe(405);
  });

  it("exposes the AgentCard on GET /.well-known/agent.json and 405s a POST", async () => {
    const a = app();
    const res = await a.fetch(new Request("http://bridge.test/.well-known/agent.json"));
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>)["skills"]).toHaveLength(1);
    expect((await a.fetch(new Request("http://bridge.test/.well-known/agent.json",
      { method: "POST" }))).status).toBe(405);
  });

  it("413s a body over the limit, both by Content-Length and by streaming accumulation", async () => {
    const a = app({ maxRequestBodyBytes: 64 });
    const big = JSON.stringify(rpc("tools/call", { name: "x", arguments: { pad: "y".repeat(500) } }));

    const declared = await a.fetch(post("/mcp", big, { "content-length": String(big.length) }));
    expect(declared.status).toBe(413);
    expect((await declared.json() as BridgeJsonRpcResponse).error?.code).toBe(C.INVALID_REQUEST);

    // A lying Content-Length must not bypass the cap.
    const lying = await a.fetch(post("/mcp", big, { "content-length": "5" }));
    expect(lying.status).toBe(413);
  });

  it("504s + -32000 on a dispatch timeout", async () => {
    const a = app({
      dispatchTimeoutMs: 10,
      dispatch: () => new Promise(() => { /* never settles */ }),
    });
    const res = await a.fetch(post("/mcp", rpc("tools/call", { name: "orders_lookup" })));
    expect(res.status).toBe(504);
    expect((await res.json() as BridgeJsonRpcResponse).error?.code).toBe(C.UPSTREAM_ERROR);
  });

  it("returns -32700 for an unparseable body", async () => {
    const res = await app().fetch(post("/mcp", "{{{"));
    expect(res.status).toBe(400);
    expect((await res.json() as BridgeJsonRpcResponse).error?.code).toBe(C.PARSE_ERROR);
  });

  it("leaks no exception detail on the catch-all arm", async () => {
    const logged: unknown[] = [];
    const a = app({
      verifyAgent: () => { throw new Error("SECRET internal detail"); },
      logError: (_m, e) => { logged.push(e); },
    });
    const res = await a.fetch(post("/mcp", rpc("ping")));
    expect(res.status).toBe(500);
    expect(logged).toHaveLength(1);            // logged server-side…
    const body = await res.text();             // …but not surfaced
    expect(body).not.toContain("SECRET");
    expect(JSON.parse(body).error).toMatchObject({
      code: C.INTERNAL_ERROR, message: "Bridge server request failed.",
    });
  });

  it("404s an unknown path", async () => {
    expect((await app().fetch(post("/nope", rpc("ping")))).status).toBe(404);
  });
});
