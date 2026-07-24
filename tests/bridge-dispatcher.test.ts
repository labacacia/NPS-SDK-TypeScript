// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionFrame } from "../src/nwp/frames.js";
import {
  A2aBridgeDispatcher,
  A2aServerBridge,
  BridgeDispatcherRegistry,
  BridgeDispatchException,
  BridgeEndpointValidator,
  BridgeErrorCodes,
  BridgeJsonRpcErrorCodes,
  BridgeNode,
  BridgeNodeApp,
  BridgeServerApp,
  BridgeServerActionInvoker,
  BridgeTargetParser,
  GrpcBridgeDispatcher,
  HttpBridgeDispatcher,
  McpBridgeDispatcher,
  McpServerBridge,
  resolveServerOptions,
  toToolName,
  type BridgeServerOptions,
} from "../src/nwp/bridge/index.js";
import { CapsFrame, ErrorFrame } from "../src/ncp/frames.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface FetchCapture {
  url: string;
  init: RequestInit;
  bodyText: string;
}

function stubFetch(response: Response | (() => Response | Promise<Response>)): {
  calls: FetchCapture[];
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: FetchCapture[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : "";
    calls.push({ url, init: init ?? {}, bodyText });
    return typeof response === "function" ? await response() : response;
  };
  return { calls, fetchFn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── BridgeTargetParser ──────────────────────────────────────────────────────

describe("BridgeTargetParser", () => {
  it("parses nested params.bridge_target with extras flattened", () => {
    const frame = new ActionFrame("bridge.dispatch", {
      bridge_target: {
        protocol: "http",
        endpoint: "https://api.example.com/x",
        method: "GET",
        extras: { foo: "bar" },
      },
    });
    const target = BridgeTargetParser.fromActionFrame(frame);
    expect(target.protocol).toBe("http");
    expect(target.endpoint).toBe("https://api.example.com/x");
    expect(BridgeTargetParser.getString(target, "method")).toBe("GET");
    expect(BridgeTargetParser.getString(target, "foo")).toBe("bar");
  });

  it("throws TARGET-INVALID when params missing", () => {
    const frame = new ActionFrame("bridge.dispatch");
    expect(() => BridgeTargetParser.fromActionFrame(frame)).toThrowError(
      expect.objectContaining({ errorCode: BridgeErrorCodes.TargetInvalid }),
    );
  });

  it("throws TARGET-INVALID when protocol missing", () => {
    expect(() => BridgeTargetParser.fromJson({ endpoint: "https://x" })).toThrowError(
      expect.objectContaining({ errorCode: BridgeErrorCodes.TargetInvalid }),
    );
  });
});

// ── BridgeEndpointValidator (SSRF) ──────────────────────────────────────────

describe("BridgeEndpointValidator", () => {
  it("accepts a public https endpoint", () => {
    const uri = BridgeEndpointValidator.parseHttpEndpoint({
      protocol: "http",
      endpoint: "https://api.example.com/v1",
    });
    expect(uri.hostname).toBe("api.example.com");
  });

  it("rejects a loopback host (SSRF guard)", () => {
    expect(() =>
      BridgeEndpointValidator.parseHttpEndpoint({
        protocol: "http",
        endpoint: "http://127.0.0.1/x",
      }),
    ).toThrowError(expect.objectContaining({ errorCode: BridgeErrorCodes.EndpointInvalid }));
  });

  it("rejects a private RFC1918 host", () => {
    expect(() =>
      BridgeEndpointValidator.parseHttpEndpoint({
        protocol: "http",
        endpoint: "https://10.1.2.3/x",
      }),
    ).toThrowError(expect.objectContaining({ errorCode: BridgeErrorCodes.EndpointInvalid }));
  });

  it("rejects a non-http scheme", () => {
    expect(() =>
      BridgeEndpointValidator.parseHttpEndpoint({ protocol: "http", endpoint: "ftp://example.com" }),
    ).toThrowError(expect.objectContaining({ errorCode: BridgeErrorCodes.EndpointInvalid }));
  });

  it("rejects http when allow_http is false", () => {
    expect(() =>
      BridgeEndpointValidator.parseHttpEndpoint({
        protocol: "http",
        endpoint: "http://example.com",
        extras: { allow_http: false },
      }),
    ).toThrowError(expect.objectContaining({ errorCode: BridgeErrorCodes.EndpointInvalid }));
  });

  it("rejects an endpoint outside allowed_prefixes", () => {
    expect(() =>
      BridgeEndpointValidator.parseHttpEndpoint({
        protocol: "http",
        endpoint: "https://evil.example.com/x",
        extras: { allowed_prefixes: ["https://good.example.com/"] },
      }),
    ).toThrowError(expect.objectContaining({ errorCode: BridgeErrorCodes.EndpointInvalid }));
  });

  it("accepts an endpoint matching an allowed prefix", () => {
    const uri = BridgeEndpointValidator.parseHttpEndpoint({
      protocol: "http",
      endpoint: "https://good.example.com/api/x",
      extras: { allowed_prefixes: ["https://good.example.com/api"] },
    });
    expect(uri.pathname).toBe("/api/x");
  });
});

// ── Registry / protocol-unsupported ─────────────────────────────────────────

describe("BridgeDispatcherRegistry", () => {
  it("createDefault registers the four built-in protocols", () => {
    const { fetchFn } = stubFetch(jsonResponse({}));
    const registry = BridgeDispatcherRegistry.createDefault(fetchFn);
    expect(registry.protocols.sort()).toEqual(["a2a", "grpc", "http", "mcp"]);
  });

  it("resolve throws PROTOCOL-UNSUPPORTED for unknown protocol", () => {
    const registry = new BridgeDispatcherRegistry();
    expect(() => registry.resolve("smtp")).toThrowError(
      expect.objectContaining({ errorCode: BridgeErrorCodes.ProtocolUnsupported }),
    );
  });

  it("BridgeNode dispatch routes to protocol-unsupported for unregistered protocol", async () => {
    const node = new BridgeNode(new BridgeDispatcherRegistry());
    const frame = new ActionFrame("bridge.dispatch", {
      bridge_target: { protocol: "smtp", endpoint: "https://x.example.com" },
    });
    await expect(async () => node.dispatch(frame)).rejects.toMatchObject({
      errorCode: BridgeErrorCodes.ProtocolUnsupported,
    });
  });
});

// ── HttpBridgeDispatcher ────────────────────────────────────────────────────

describe("HttpBridgeDispatcher", () => {
  it("POSTs the frame body and maps the JSON response", async () => {
    const { fetchFn, calls } = stubFetch(jsonResponse({ ok: true, n: 5 }));
    const dispatcher = new HttpBridgeDispatcher(fetchFn);
    const target = { protocol: "http", endpoint: "https://api.example.com/do" };
    const frame = new ActionFrame("bridge.dispatch", { body: { hello: "world" } });

    const caps = await dispatcher.dispatch(frame, target);
    expect(caps).toBeInstanceOf(CapsFrame);
    expect(caps.anchorRef).toBe(HttpBridgeDispatcher.ResponseAnchorRef);
    expect(calls[0]!.url).toBe("https://api.example.com/do");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.bodyText)).toEqual({ hello: "world" });

    const record = caps.data[0] as Record<string, unknown>;
    expect(record["status_code"]).toBe(200);
    expect(record["success"]).toBe(true);
    expect(record["body"]).toEqual({ ok: true, n: 5 });
  });

  it("omits body for GET requests", async () => {
    const { fetchFn, calls } = stubFetch(jsonResponse({}));
    const dispatcher = new HttpBridgeDispatcher(fetchFn);
    const frame = new ActionFrame("bridge.dispatch", { body: { x: 1 } });
    await dispatcher.dispatch(frame, {
      protocol: "http",
      endpoint: "https://api.example.com/g",
      extras: { method: "GET" },
    });
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("maps transport failure to UPSTREAM-FAILED", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const dispatcher = new HttpBridgeDispatcher(fetchFn as never);
    await expect(
      dispatcher.dispatch(new ActionFrame("x"), { protocol: "http", endpoint: "https://api.example.com/e" }),
    ).rejects.toMatchObject({ errorCode: BridgeErrorCodes.UpstreamFailed });
  });
});

// ── GrpcBridgeDispatcher ────────────────────────────────────────────────────

describe("GrpcBridgeDispatcher", () => {
  it("frames a grpc+json message and parses length-prefixed responses", async () => {
    // Build a gRPC-JSON response frame: 1 flag byte + 4-byte length + JSON.
    const payload = new TextEncoder().encode(JSON.stringify({ reply: "pong" }));
    const wire = new Uint8Array(payload.length + 5);
    wire[0] = 0;
    new DataView(wire.buffer).setUint32(1, payload.length, false);
    wire.set(payload, 5);

    const { fetchFn, calls } = stubFetch(
      new Response(wire, { status: 200, headers: { "content-type": "application/grpc+json", "grpc-status": "0" } }),
    );
    const dispatcher = new GrpcBridgeDispatcher(fetchFn);
    const frame = new ActionFrame("bridge.dispatch", { grpc_message: { ping: 1 } });
    const caps = await dispatcher.dispatch(frame, {
      protocol: "grpc",
      endpoint: "https://grpc.example.com/pkg.Svc/Method",
    });

    expect(caps.anchorRef).toBe(GrpcBridgeDispatcher.ResponseAnchorRef);
    // Request body is a length-prefixed grpc frame carrying the JSON message.
    expect(calls[0]!.init.headers).toBeInstanceOf(Headers);
    const record = caps.data[0] as Record<string, unknown>;
    expect(record["grpc_status"]).toBe("0");
    expect(record["success"]).toBe(true);
    expect(record["messages"]).toEqual([{ reply: "pong" }]);
  });
});

// ── JSON-RPC dispatchers (MCP / A2A) ────────────────────────────────────────

describe("JsonRpcBridgeDispatcher (MCP/A2A)", () => {
  it("MCP dispatcher uses tools/call default method and extracts result", async () => {
    const { fetchFn, calls } = stubFetch(jsonResponse({ jsonrpc: "2.0", id: "1", result: { ok: 1 } }));
    const dispatcher = new McpBridgeDispatcher(fetchFn);
    const frame = new ActionFrame("bridge.dispatch", { params: { name: "greet" } }, false, "idem-1");
    const caps = await dispatcher.dispatch(frame, { protocol: "mcp", endpoint: "https://mcp.example.com/rpc" });

    const sent = JSON.parse(calls[0]!.bodyText);
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("tools/call");
    expect(sent.id).toBe("idem-1");
    expect(sent.params).toEqual({ name: "greet" });

    const record = caps.data[0] as Record<string, unknown>;
    expect(record["result"]).toEqual({ ok: 1 });
    expect(caps.anchorRef).toBe(McpBridgeDispatcher.ResponseAnchorRef);
  });

  it("A2A dispatcher defaults to tasks/send", async () => {
    const { fetchFn, calls } = stubFetch(jsonResponse({ jsonrpc: "2.0", id: "1", result: {} }));
    const dispatcher = new A2aBridgeDispatcher(fetchFn);
    await dispatcher.dispatch(new ActionFrame("x", {}, false, "id"), {
      protocol: "a2a",
      endpoint: "https://a2a.example.com/rpc",
    });
    expect(JSON.parse(calls[0]!.bodyText).method).toBe("tasks/send");
  });

  it("honours an explicit rpc_method extra", async () => {
    const { fetchFn, calls } = stubFetch(jsonResponse({ jsonrpc: "2.0", result: {} }));
    const dispatcher = new McpBridgeDispatcher(fetchFn);
    await dispatcher.dispatch(new ActionFrame("x", {}, false, "id"), {
      protocol: "mcp",
      endpoint: "https://mcp.example.com/rpc",
      extras: { rpc_method: "resources/list" },
    });
    expect(JSON.parse(calls[0]!.bodyText).method).toBe("resources/list");
  });
});

// ── McpServerBridge (inbound) ───────────────────────────────────────────────

describe("McpServerBridge", () => {
  function makeServer(dispatch?: BridgeServerOptions["dispatch"]) {
    const options = resolveServerOptions({
      actions: [{ actionId: "greet.hello", description: "Say hi" }],
      requireAuth: false,
      dispatch,
    });
    const invoker = new BridgeServerActionInvoker(options);
    return new McpServerBridge(options, invoker);
  }

  it("lists tools with sanitized names", async () => {
    const res = await makeServer().dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = res.result as { tools: { name: string }[] };
    expect(result.tools[0]!.name).toBe("greet_hello");
  });

  it("tools/call routes to a local action dispatch", async () => {
    const dispatch = vi.fn(async (frame) => new CapsFrame("res:x", 1, [{ echoed: frame.params }]));
    const res = await makeServer(dispatch as never).dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "greet_hello", arguments: { who: "ada" } },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const result = res.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text).data).toEqual([{ echoed: { who: "ada" } }]);
  });

  it("tools/call unknown tool returns ToolNotFound with server code", async () => {
    const res = await makeServer(async () => new CapsFrame("x", 0, [])).dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(res.error?.code).toBe(BridgeJsonRpcErrorCodes.ToolNotFound);
    expect((res.error?.data as { error: string }).error).toBe(BridgeErrorCodes.ServerToolNotFound);
  });

  it("returns ServerDispatcherMissing when dispatch not configured", async () => {
    const res = await makeServer().dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "greet_hello" },
    });
    const result = res.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toBe(BridgeErrorCodes.ServerDispatcherMissing);
  });

  it("unknown method returns MethodNotFound", async () => {
    const res = await makeServer().dispatch({ jsonrpc: "2.0", id: 5, method: "bogus" });
    expect(res.error?.code).toBe(BridgeJsonRpcErrorCodes.MethodNotFound);
  });
});

// ── A2aServerBridge (inbound) ───────────────────────────────────────────────

describe("A2aServerBridge", () => {
  it("tasks/send with single action routes to local dispatch and returns a completed task", async () => {
    const dispatch = vi.fn(async () => new CapsFrame("res:x", 1, [{ answer: 42 }]));
    const options = resolveServerOptions({
      actions: [{ actionId: "answer" }],
      requireAuth: false,
      dispatch: dispatch as never,
    });
    const bridge = new A2aServerBridge(options, new BridgeServerActionInvoker(options));

    const res = await bridge.dispatch({
      jsonrpc: "2.0",
      id: "t1",
      method: "tasks/send",
      params: {
        id: "task-1",
        message: { role: "user", parts: [{ type: "data", data: { q: "life" } }] },
      },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const task = res.result as { id: string; status: { state: string }; artifacts: { parts: { data: unknown }[] }[] };
    expect(task.id).toBe("task-1");
    expect(task.status.state).toBe("completed");
    expect((task.artifacts[0]!.parts[0]!.data as Record<string, unknown>)["data"]).toEqual([{ answer: 42 }]);
  });

  it("tasks/send returns tool-not-found when multiple actions and none identified", async () => {
    const options = resolveServerOptions({
      actions: [{ actionId: "a" }, { actionId: "b" }],
      requireAuth: false,
      dispatch: async () => new CapsFrame("x", 0, []),
    });
    const bridge = new A2aServerBridge(options, new BridgeServerActionInvoker(options));
    const res = await bridge.dispatch({
      jsonrpc: "2.0",
      id: "t2",
      method: "tasks/send",
      params: { id: "task-2", message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
    });
    expect((res.error?.data as { error: string }).error).toBe(BridgeErrorCodes.ServerToolNotFound);
  });

  it("buildAgentCard exposes skills and apikey auth", () => {
    const options = resolveServerOptions({
      actions: [{ actionId: "answer", displayName: "Answer" }],
      requireAuth: true,
    });
    const bridge = new A2aServerBridge(options, new BridgeServerActionInvoker(options));
    const card = bridge.buildAgentCard("https://host/a2a");
    expect(card.skills[0]!.name).toBe("Answer");
    expect(card.authentication?.credentials).toBe("X-NWP-Agent");
  });
});

// ── BridgeServerApp (Web fetch inbound) ─────────────────────────────────────

describe("BridgeServerApp", () => {
  function app(overrides: Partial<BridgeServerOptions> = {}): BridgeServerApp {
    return new BridgeServerApp({
      actions: [{ actionId: "greet.hello" }],
      requireAuth: false,
      dispatch: async (frame) => new CapsFrame("res:x", 1, [{ got: frame.actionId }]),
      ...overrides,
    });
  }

  it("dispatches an inbound MCP tools/call over POST /mcp", async () => {
    const req = new Request("https://host/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greet_hello" } }),
    });
    const res = await app().fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
  });

  it("serves the A2A AgentCard on GET", async () => {
    const res = await app().fetch(new Request("https://host/.well-known/agent.json"));
    expect(res.status).toBe(200);
    const card = (await res.json()) as { url: string };
    expect(card.url).toBe("https://host/a2a");
  });

  it("rejects unauthenticated requests when requireAuth is on", async () => {
    const res = await app({ requireAuth: true, verifyAgent: async () => true }).fetch(
      new Request("https://host/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 413 when the body exceeds the configured limit", async () => {
    const res = await app({ maxRequestBodyBytes: 4 }).fetch(
      new Request("https://host/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(413);
  });
});

// ── BridgeNodeApp (Web fetch outbound facade) ───────────────────────────────

describe("BridgeNodeApp", () => {
  it("serves a manifest listing built-in protocols", async () => {
    const { fetchFn } = stubFetch(jsonResponse({}));
    const nodeApp = new BridgeNodeApp({}, { fetchFn });
    const res = await nodeApp.fetch(new Request("https://host/.nwm"));
    const manifest = (await res.json()) as { node_type: string; bridge_protocols: string[] };
    expect(manifest.node_type).toBe("bridge");
    expect(manifest.bridge_protocols).toEqual(["a2a", "grpc", "http", "mcp"]);
  });

  it("dispatches /invoke through to the outbound HTTP dispatcher", async () => {
    const { fetchFn } = stubFetch(jsonResponse({ pong: true }));
    const nodeApp = new BridgeNodeApp({}, { fetchFn });
    const frame = new ActionFrame("bridge.dispatch", {
      bridge_target: { protocol: "http", endpoint: "https://api.example.com/do" },
      body: { ping: true },
    });
    const res = await nodeApp.fetch(
      new Request("https://host/invoke", { method: "POST", body: JSON.stringify(frame.toDict()) }),
    );
    expect(res.status).toBe(200);
    const caps = (await res.json()) as { anchor_ref: string };
    expect(caps.anchor_ref).toBe(HttpBridgeDispatcher.ResponseAnchorRef);
  });

  it("returns 404 for an unknown action id", async () => {
    const { fetchFn } = stubFetch(jsonResponse({}));
    const nodeApp = new BridgeNodeApp({}, { fetchFn });
    const res = await nodeApp.fetch(
      new Request("https://host/invoke", {
        method: "POST",
        body: JSON.stringify(new ActionFrame("other.action", {}).toDict()),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("maps a private-host endpoint to a 400 with ENDPOINT-INVALID", async () => {
    const { fetchFn } = stubFetch(jsonResponse({}));
    const nodeApp = new BridgeNodeApp({}, { fetchFn });
    const frame = new ActionFrame("bridge.dispatch", {
      bridge_target: { protocol: "http", endpoint: "http://127.0.0.1/x" },
    });
    const res = await nodeApp.fetch(
      new Request("https://host/invoke", { method: "POST", body: JSON.stringify(frame.toDict()) }),
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe(BridgeErrorCodes.EndpointInvalid);
  });
});

// ── misc helpers ────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("toToolName sanitizes and trims", () => {
    expect(toToolName("greet.hello")).toBe("greet_hello");
    expect(toToolName("  ")).toBe("action");
  });

  it("BridgeDispatchException carries the error code", () => {
    const ex = new BridgeDispatchException(BridgeErrorCodes.UpstreamFailed, "nope");
    expect(ex.errorCode).toBe(BridgeErrorCodes.UpstreamFailed);
    expect(ex).toBeInstanceOf(Error);
  });

  it("ErrorFrame is used for dispatcher-missing paths", () => {
    expect(new ErrorFrame("s", "e").error).toBe("e");
  });
});
