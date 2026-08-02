// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosting layer for a Bridge Node's inbound surface — a Web-standard `fetch` handler,
 * matching this SDK's `AnchorNodeApp` / `MemoryNodeServer` binding style.
 *
 * The layering rule of NPS-CR-0010 is preserved: {@link BridgeInboundOptions} is
 * transport-independent and the protocol servers are written against it alone;
 * {@link BridgeServerOptions} adds the hosting concerns (paths, a request-bound verifier,
 * limits) and only this file knows about them. That is what lets the MCP server also run over
 * stdio, or straight from a unit test with no web host.
 */

import { A2aInboundServer } from "./a2a.js";
import { createBridgeServerBackends, resolveBridgeInboundOptions,
  type BridgeInboundOptions, type ResolvedBridgeInboundOptions } from "./options.js";
import type { FetchLike, INwpBackend } from "./backend.js";
import {
  BridgeJsonRpcErrorCodes,
  jsonRpcError,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import { McpInboundServer } from "./mcp.js";

/** Verifies a caller NID against the live request. Fail-closed when absent. */
export type BridgeAgentVerifier = (agentNid: string, request: Request) => boolean | Promise<boolean>;

export interface BridgeServerOptions extends BridgeInboundOptions {
  /** Prefix every path below is mounted under. Default `""`. */
  pathPrefix?: string;
  /** Default `"/mcp"`. `"/mcp/sse"` is also accepted. */
  mcpPath?: string;
  /** Default `"/a2a"`. */
  a2aPath?: string;
  /** Default `"/.well-known/agent.json"`. */
  a2aAgentCardPath?: string;
  /**
   * Verifier for the caller NID. **If auth is required and no verifier is configured, every
   * request is denied** — fail-closed. It receives the whole `Request` on purpose, so a
   * deployment can bind the NID to a NIP client certificate off the connection.
   */
  verifyAgent?: BridgeAgentVerifier;
  /** Max request body size in bytes. Default 1 MiB; 0 disables. */
  maxRequestBodyBytes?: number;
  /** Dispatch timeout in ms. Default 30_000; 0 disables. */
  dispatchTimeoutMs?: number;
  /** Injected for {@link createBridgeServerBackends} when upstreams are configured. */
  fetchImpl?: FetchLike;
  /** Server-side sink for the sanitized-error arm. Defaults to `console.error`. */
  logError?: (message: string, error: unknown) => void;
}

const DEFAULTS = {
  pathPrefix: "",
  mcpPath: "/mcp",
  a2aPath: "/a2a",
  a2aAgentCardPath: "/.well-known/agent.json",
  maxRequestBodyBytes: 1024 * 1024,
  dispatchTimeoutMs: 30_000,
} as const;

const AGENT_HEADER = "X-NWP-Agent";
/** Streaming accumulation chunk, so a lying Content-Length cannot bypass the cap. */
const CHUNK_BYTES = 80 * 1024;

/**
 * Syntactic validation of a caller NID: prefix `urn:nps:agent:`, total length ≤ 512, then
 * `{domain}:{identifier}` with both segments non-empty.
 */
export function isValidAgentNid(nid: string): boolean {
  const PREFIX = "urn:nps:agent:";
  if (!nid.startsWith(PREFIX) || nid.length > 512) return false;
  const rest = nid.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return false;
  const domain = rest.slice(0, sep);
  const identifier = rest.slice(sep + 1);
  return /^[A-Za-z0-9.\-]+$/.test(domain) && /^[A-Za-z0-9._~:@/\-]+$/.test(identifier);
}

/** The inbound Bridge Node hosting app. Mount {@link fetch} on any WHATWG-fetch runtime. */
export class BridgeInboundApp {
  readonly mcp: McpInboundServer;
  readonly a2a: A2aInboundServer;
  readonly backends: readonly INwpBackend[];

  private readonly inbound: ResolvedBridgeInboundOptions;
  private readonly opt: Required<Pick<BridgeServerOptions,
    "pathPrefix" | "mcpPath" | "a2aPath" | "a2aAgentCardPath"
    | "maxRequestBodyBytes" | "dispatchTimeoutMs">> & BridgeServerOptions;

  constructor(options: BridgeServerOptions = {}, backends?: readonly INwpBackend[]) {
    this.opt = { ...DEFAULTS, ...options };
    this.inbound = resolveBridgeInboundOptions(options);
    this.backends = backends ?? createBridgeServerBackends(options, options.fetchImpl);
    this.mcp = new McpInboundServer(options, this.backends);
    this.a2a = new A2aInboundServer(options, this.backends);
  }

  fetch = async (req: Request): Promise<Response> => {
    const prefix = this.opt.pathPrefix.replace(/\/+$/, "");
    const path = new URL(req.url).pathname;
    if (prefix && !path.startsWith(prefix)) return new Response(null, { status: 404 });
    const sub = prefix ? path.slice(prefix.length) : path;

    try {
      if (sub === this.opt.a2aAgentCardPath) {
        if (req.method !== "GET") return new Response(null, { status: 405 });
        const card = await this.a2a.buildAgentCard(
          new URL(this.opt.a2aPath, new URL(req.url).origin).toString());
        return json(200, card);
      }

      const isMcp = sub === this.opt.mcpPath || sub === `${this.opt.mcpPath}/sse`;
      const isA2a = sub === this.opt.a2aPath;
      if (!isMcp && !isA2a) return new Response(null, { status: 404 });
      if (req.method !== "POST") return new Response(null, { status: 405 });

      // ── auth gate ────────────────────────────────────────────────────────
      const denied = await this.checkAuth(req);
      if (denied) return denied;

      // ── bounded body ─────────────────────────────────────────────────────
      const body = await this.readBoundedBody(req);
      if (body instanceof Response) return body;

      let request: BridgeJsonRpcRequest;
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (typeof parsed?.["method"] !== "string") throw new SyntaxError("method is required");
        request = parsed as unknown as BridgeJsonRpcRequest;
      } catch (e) {
        return json(400, jsonRpcError(null, BridgeJsonRpcErrorCodes.PARSE_ERROR,
          e instanceof Error ? e.message : String(e)));
      }

      // ── dispatch (with timeout) ──────────────────────────────────────────
      const server = isMcp ? this.mcp : this.a2a;
      const response = await this.withTimeout((signal) => server.dispatch(request, signal));
      if (response === TIMED_OUT) {
        return json(504, jsonRpcError(request, BridgeJsonRpcErrorCodes.UPSTREAM_ERROR,
          "Bridge server dispatch timed out."));
      }
      return json(200, response);
    } catch (e) {
      // Sanitized catch-all: log server-side, leak no exception detail to the foreign client.
      (this.opt.logError ?? ((m, err) => console.error(m, err)))("Bridge server request failed.", e);
      return json(500, jsonRpcError(null, BridgeJsonRpcErrorCodes.INTERNAL_ERROR,
        "Bridge server request failed."));
    }
  };

  // ── gates ────────────────────────────────────────────────────────────────

  private async checkAuth(req: Request): Promise<Response | null> {
    if (!this.inbound.requireAuth) return null;
    const unauthorized = () => json(401,
      jsonRpcError(null, BridgeJsonRpcErrorCodes.INVALID_REQUEST,
        "A valid X-NWP-Agent NID is required."));

    const agentNid = req.headers.get(AGENT_HEADER);
    if (!agentNid || agentNid.trim() === "") return unauthorized();
    if (!isValidAgentNid(agentNid)) return unauthorized();
    // Fail-closed: auth required but no verifier configured ⇒ deny everything.
    if (!this.opt.verifyAgent) return unauthorized();
    return (await this.opt.verifyAgent(agentNid, req)) ? null : unauthorized();
  }

  /**
   * Enforced twice: a `Content-Length` pre-check AND a streaming accumulate that aborts as
   * soon as the running total would exceed the cap, so a lying or absent Content-Length
   * cannot bypass it.
   */
  private async readBoundedBody(req: Request): Promise<string | Response> {
    const cap = this.opt.maxRequestBodyBytes;
    const tooLarge = () => json(413,
      jsonRpcError(null, BridgeJsonRpcErrorCodes.INVALID_REQUEST,
        `Request body exceeds the ${cap}-byte limit.`));

    if (cap > 0) {
      const declared = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > cap) return tooLarge();
    }

    if (cap === 0 || req.body === null) return req.text();

    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; i += CHUNK_BYTES) {
          const chunk = value.subarray(i, Math.min(i + CHUNK_BYTES, value.length));
          total += chunk.length;
          if (total > cap) return tooLarge();
          out += decoder.decode(chunk, { stream: true });
        }
      }
      out += decoder.decode();
      return out;
    } finally {
      reader.releaseLock();
    }
  }

  private async withTimeout(
    run: (signal: AbortSignal) => Promise<BridgeJsonRpcResponse>,
  ): Promise<BridgeJsonRpcResponse | typeof TIMED_OUT> {
    const ms = this.opt.dispatchTimeoutMs;
    if (ms <= 0) return run(new AbortController().signal);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
      const result = await Promise.race([run(controller.signal), timeout]);
      if (result === TIMED_OUT) {
        // Cancel the orphaned dispatch; its eventual fault is logged out-of-band.
        controller.abort();
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const TIMED_OUT = Symbol("bridge-dispatch-timeout");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
