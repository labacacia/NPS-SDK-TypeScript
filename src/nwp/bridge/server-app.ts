// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { HDR_AGENT } from "../http-headers.js";
import {
  BridgeJsonRpc,
  BridgeJsonRpcErrorCodes,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import { McpServerBridge } from "./mcp-server-bridge.js";
import { A2aServerBridge } from "./a2a-server-bridge.js";
import {
  BridgeServerActionInvoker,
  resolveServerOptions,
  type BridgeServerOptions,
  type ResolvedBridgeServerOptions,
} from "./server-options.js";

type DispatchFn = (request: BridgeJsonRpcRequest) => Promise<BridgeJsonRpcResponse>;

interface BridgeHttpResult {
  httpStatus: number;
  response: BridgeJsonRpcResponse;
}

/**
 * WHATWG Fetch handler exposing inbound MCP/A2A Bridge server adapters
 * (port of .NET `BridgeServerMiddleware`). Mounts on any WHATWG-fetch runtime.
 */
export class BridgeServerApp {
  private readonly options: ResolvedBridgeServerOptions;
  private readonly mcp: McpServerBridge;
  private readonly a2a: A2aServerBridge;

  constructor(options: BridgeServerOptions, mcp?: McpServerBridge, a2a?: A2aServerBridge) {
    this.options = resolveServerOptions(options);
    const invoker = new BridgeServerActionInvoker(this.options);
    this.mcp = mcp ?? new McpServerBridge(this.options, invoker);
    this.a2a = a2a ?? new A2aServerBridge(this.options, invoker);
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const prefix = this.options.pathPrefix.replace(/\/+$/, "");

    if (!path.toLowerCase().startsWith(prefix.toLowerCase())) {
      return notFound();
    }

    const sub = path.slice(prefix.length);
    const mcpSse = append(this.options.mcpPath, "/sse");

    if (matches(sub, this.options.mcpPath) || matches(sub, mcpSse)) {
      return this.handleMcp(req, isSseRequest(req) || matches(sub, mcpSse));
    }
    if (matches(sub, this.options.a2aPath)) {
      return this.handleA2a(req);
    }
    if (matches(sub, this.options.a2aAgentCardPath)) {
      return this.handleAgentCard(req, url);
    }

    return notFound();
  };

  private async handleMcp(req: Request, useSse: boolean): Promise<Response> {
    if (req.method === "GET" && useSse) {
      const endpoint = join(this.options.pathPrefix, this.options.mcpPath);
      return new Response(`event: endpoint\ndata: ${endpoint}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (req.method !== "POST") return new Response(null, { status: 405 });

    const auth = await this.authorize(req);
    if (!auth.authorized) {
      return writeJson(401, BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.InvalidRequest, auth.message));
    }

    const result = await this.readAndDispatch(req, (r) => this.mcp.dispatch(r));
    if (useSse) return writeSse(result.response, result.httpStatus);
    return writeJson(result.httpStatus, result.response);
  }

  private async handleA2a(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    const auth = await this.authorize(req);
    if (!auth.authorized) {
      return writeJson(401, BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.InvalidRequest, auth.message));
    }

    const result = await this.readAndDispatch(req, (r) => this.a2a.dispatch(r));
    return writeJson(result.httpStatus, result.response);
  }

  private handleAgentCard(req: Request, url: URL): Response {
    if (req.method !== "GET") return new Response(null, { status: 405 });
    const endpoint = `${url.protocol}//${url.host}${join(this.options.pathPrefix, this.options.a2aPath)}`;
    return writeJson(200, this.a2a.buildAgentCard(endpoint));
  }

  private async readAndDispatch(req: Request, dispatch: DispatchFn): Promise<BridgeHttpResult> {
    let request: BridgeJsonRpcRequest | null;
    try {
      request = await this.readJsonRpcRequest(req);
    } catch (err) {
      if (err instanceof BridgePayloadTooLargeError) {
        return {
          httpStatus: 413,
          response: BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.InvalidRequest, err.message),
        };
      }
      return {
        httpStatus: 400,
        response: BridgeJsonRpc.error(
          null,
          BridgeJsonRpcErrorCodes.ParseError,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }

    if (request == null) {
      return {
        httpStatus: 400,
        response: BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.InvalidRequest, "JSON-RPC request is required."),
      };
    }

    try {
      return { httpStatus: 200, response: await this.dispatchWithTimeout(request, dispatch) };
    } catch (err) {
      if (err instanceof BridgeDispatchTimeoutError) {
        return {
          httpStatus: 504,
          response: BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.UpstreamError, err.message),
        };
      }
      return {
        httpStatus: 500,
        response: BridgeJsonRpc.error(null, BridgeJsonRpcErrorCodes.InternalError, "Bridge server request failed."),
      };
    }
  }

  private async readJsonRpcRequest(req: Request): Promise<BridgeJsonRpcRequest | null> {
    const maxBytes = this.options.maxRequestBodyBytes;
    const text = await req.text();

    if (maxBytes > 0) {
      const size = new TextEncoder().encode(text).length;
      if (size > maxBytes) throw new BridgePayloadTooLargeError(maxBytes);
    }

    if (text.trim() === "") return null;
    return JSON.parse(text) as BridgeJsonRpcRequest;
  }

  private async dispatchWithTimeout(
    request: BridgeJsonRpcRequest,
    dispatch: DispatchFn,
  ): Promise<BridgeJsonRpcResponse> {
    if (this.options.dispatchTimeoutMs === 0) return await dispatch(request);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BridgeDispatchTimeoutError(this.options.dispatchTimeoutMs)),
        this.options.dispatchTimeoutMs,
      );
    });

    try {
      return await Promise.race([dispatch(request), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async authorize(req: Request): Promise<{ authorized: boolean; message: string }> {
    if (!this.options.requireAuth) return { authorized: true, message: "" };

    const value = req.headers.get(HDR_AGENT);
    if (value == null || value.trim() === "") {
      return { authorized: false, message: "A valid X-NWP-Agent NID is required." };
    }

    const agentNid = value.trim();
    if (!isValidAgentNid(agentNid)) {
      return { authorized: false, message: "A valid X-NWP-Agent NID is required." };
    }

    if (this.options.verifyAgent === undefined) {
      return { authorized: false, message: "Bridge server agent verifier is required." };
    }

    if (!(await this.options.verifyAgent(agentNid, req))) {
      return { authorized: false, message: "X-NWP-Agent was rejected by Bridge server policy." };
    }

    return { authorized: true, message: "" };
  }
}

function isValidAgentNid(nid: string): boolean {
  const prefix = "urn:nps:agent:";
  if (!nid.startsWith(prefix) || nid.length > 512) return false;

  const rest = nid.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return false;

  const domain = rest.slice(0, sep);
  const identifier = rest.slice(sep + 1);
  return [...domain].every(isDomainChar) && [...identifier].every(isIdentifierChar);
}

function isDomainChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch) || ch === "." || ch === "-";
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch) || "._-~:@/".includes(ch);
}

function writeJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeSse(response: BridgeJsonRpcResponse, status: number): Response {
  const payload = JSON.stringify(response);
  return new Response(`event: message\ndata: ${payload}\n\n`, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function matches(actual: string, expected: string): boolean {
  const normalized = expected.startsWith("/") ? expected : "/" + expected;
  return actual.toLowerCase() === normalized.toLowerCase() ||
    actual.toLowerCase() === (normalized + "/").toLowerCase();
}

function append(path: string, suffix: string): string {
  return path.replace(/\/+$/, "") + suffix;
}

function join(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.startsWith("/") ? path : "/" + path;
  return left === "" ? right : left + right;
}

function isSseRequest(req: Request): boolean {
  const accept = req.headers.get("accept");
  return accept != null && accept.toLowerCase().includes("text/event-stream");
}

class BridgePayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Bridge server request body exceeds the configured ${maxBytes} byte limit.`);
    this.name = "BridgePayloadTooLargeError";
  }
}

class BridgeDispatchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Bridge server dispatch timed out after ${timeoutMs}ms.`);
    this.name = "BridgeDispatchTimeoutError";
  }
}
