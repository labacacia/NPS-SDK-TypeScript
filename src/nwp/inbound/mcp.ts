// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound **MCP** server surface of a Bridge Node (NWP §2.1 inbound profile, §16.1.2).
 * Projects the NWP nodes behind one or more {@link INwpBackend} instances onto MCP:
 * Memory / Complex Nodes become resources, Action / Complex Nodes become tools.
 *
 * Unlike both pre-CR-0010 implementations it serves the full method set over either backend
 * shape, and it maps NPS failures onto JSON-RPC errors per §16.3 instead of returning them as
 * a "successful" result carrying `isError: true`.
 */

import { NpsStatusCodes } from "../../core/status-codes.js";
import {
  isInvokable,
  isQueryable,
  openObjectSchema,
  type INwpBackend,
  type NwpActionDescriptor,
  type NwpNodeDescriptor,
  type NwpResult,
} from "./backend.js";
import { BridgeErrorCodes, mustBeProtocolError, toJsonRpc } from "./error-map.js";
import {
  BridgeJsonRpcErrorCodes,
  jsonRpcError,
  jsonRpcSuccess,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import {
  directionHint,
  resolveBridgeInboundOptions,
  servesInbound,
  type BridgeInboundOptions,
  type ResolvedBridgeInboundOptions,
} from "./options.js";

/**
 * Encodes an NWP `(node, action_id)` pair as a protocol-safe MCP tool name. MCP tool names
 * are a flat namespace, so the node name is folded in with a `__` separator; dots in an
 * action id — legal in NPS, awkward in some MCP clients — become underscores.
 *
 * **Encoding only.** There is deliberately no decode: the transform is lossy (a dot and an
 * underscore both map to underscore; a node name may itself contain `__`), so an inverse
 * would be ambiguous. Callers resolve a tool name by **re-encoding** each candidate
 * `(node, action)` and comparing, never by splitting the incoming string.
 */
export const McpToolName = {
  SEPARATOR: "__",

  encode(nodeName: string, actionId: string): string {
    return `${sanitize(nodeName)}${McpToolName.SEPARATOR}${McpToolName.encodeActionSegment(actionId)}`;
  },

  /** Just the action segment (no node prefix) — the bare form a pre-CR-0010 client saw. */
  encodeActionSegment(actionId: string): string {
    return sanitize(actionId).replace(/\./g, "_");
  },
} as const;

function sanitize(value: string): string {
  if (!value || value.trim() === "") return "node";
  const mapped = [...value.trim()]
    .map((ch) => (/[A-Za-z0-9_\-.]/.test(ch) ? ch : "_"))
    .join("");
  const trimmed = mapped.replace(/^_+/, "").replace(/_+$/, "");
  return trimmed === "" ? "node" : trimmed;
}

/** A resolved `(backend, action)` pair. */
interface ResolvedTool {
  backend: INwpBackend;
  descriptor: NwpNodeDescriptor;
  action: NwpActionDescriptor;
}

export class McpInboundServer {
  /** MCP methods a conformant inbound Bridge Node MUST serve (NWP §16.1.2 MUST-3). */
  static readonly REQUIRED_METHODS: readonly string[] = [
    "initialize", "ping", "tools/list", "tools/call", "resources/list", "resources/read",
  ];

  private readonly options: ResolvedBridgeInboundOptions;

  constructor(
    options: BridgeInboundOptions,
    private readonly backends: readonly INwpBackend[],
  ) {
    this.options = resolveBridgeInboundOptions(options);
  }

  /** Dispatch one MCP JSON-RPC request. */
  async dispatch(request: BridgeJsonRpcRequest, signal?: AbortSignal): Promise<BridgeJsonRpcResponse> {
    if (request === null || request === undefined) throw new TypeError("request is required");

    // §16.1.2 MUST-5: reject a protocol this Bridge Node did not declare in
    // bridge_inbound_protocols, rather than serving it anyway.
    if (!servesInbound(this.options, "mcp")) {
      return jsonRpcError(request,
        toJsonRpc(NpsStatusCodes.NPS_SERVER_UNSUPPORTED),
        'This Bridge Node does not declare "mcp" in bridge_inbound_protocols.',
        { error: BridgeErrorCodes.DIRECTION_UNSUPPORTED, hint: directionHint(this.options) });
    }

    try {
      switch (request.method) {
        case "initialize":     return jsonRpcSuccess(request, this.initialize());
        case "ping":           return jsonRpcSuccess(request, {});
        case "tools/list":     return jsonRpcSuccess(request, await this.listTools(signal));
        case "tools/call":     return await this.callTool(request, signal);
        case "resources/list": return jsonRpcSuccess(request, await this.listResources(signal));
        case "resources/read": return await this.readResource(request, signal);
        default:
          return jsonRpcError(request, BridgeJsonRpcErrorCodes.METHOD_NOT_FOUND,
            `MCP method '${request.method}' is not supported by this Bridge Node.`,
            { error: BridgeErrorCodes.DIRECTION_UNSUPPORTED, hint: directionHint(this.options) });
      }
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof TypeError) {
        return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
          e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  }

  // ── initialize ─────────────────────────────────────────────────────────────

  private initialize(): Record<string, unknown> {
    return {
      serverInfo: { name: this.options.serverName, version: this.options.serverVersion },
      // Both capabilities are ALWAYS advertised: §16.1.2 requires the resource *methods* to
      // be served even when no Memory Node sits behind this Bridge.
      capabilities: { tools: {}, resources: {} },
    };
  }

  // ── tools/list ─────────────────────────────────────────────────────────────

  private async listTools(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const tools: Record<string, unknown>[] = [];
    for (const backend of this.backends) {
      const descriptor = await backend.getDescriptor(signal);
      if (!isInvokable(descriptor)) continue;
      for (const action of await backend.getActions(signal)) {
        const tool: Record<string, unknown> = {
          // Always the QUALIFIED form: canonical on output, forgiving on input.
          name: McpToolName.encode(descriptor.name, action.actionId),
          inputSchema: action.inputSchema ?? openObjectSchema(),
        };
        if (action.description !== undefined) tool["description"] = action.description;
        tools.push(tool);
      }
    }
    return { tools };
  }

  // ── tools/call ─────────────────────────────────────────────────────────────

  private async callTool(
    request: BridgeJsonRpcRequest, signal?: AbortSignal,
  ): Promise<BridgeJsonRpcResponse> {
    const params = asObject(request.params);
    const name = params?.["name"];
    if (typeof name !== "string" || name.trim() === "") {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        "MCP tools/call requires params.name.");
    }

    const resolution = await this.resolveTool(name, signal);
    if (resolution.tool === null) {
      return jsonRpcError(request,
        // §16.3: an unknown tool is a missing *method* to an MCP client. The retired -32002
        // is deliberately not reused.
        BridgeJsonRpcErrorCodes.METHOD_NOT_FOUND,
        `MCP tool '${name}' is not exposed by this Bridge Node.`,
        {
          error: BridgeErrorCodes.SERVER_TOOL_NOT_FOUND,
          tool: name,
          // TC-N2-BridgeIn-04 wants an ambiguous rejection to name both qualified candidates.
          // The .NET message names only the requested tool; this port adds the list.
          ...(resolution.candidates.length > 0 ? { candidates: resolution.candidates } : {}),
        });
    }

    const { backend, action } = resolution.tool;
    const result = await backend.invoke(action.actionId, params?.["arguments"], action.async ?? false, signal);
    return this.toToolCallResponse(request, result);
  }

  /**
   * Resolve an MCP tool name to its backend and action.
   *
   * Canonical on output, forgiving on input. `tools/list` always emits the qualified
   * `node__action` form — it has to, since MCP tool names are a flat namespace and a Bridge
   * may front several nodes. But a bare action id is also accepted **when it resolves
   * unambiguously**, so clients written against the pre-CR-0010 in-process Bridge (which
   * emitted unqualified names) keep working.
   *
   * Matching is by **re-encoding, never by decoding** the incoming name: the encoding is
   * lossy, so a decode would mis-split `node__a_b` into action `a.b`, or misparse a node
   * whose own name contains `__`.
   */
  private async resolveTool(
    toolName: string, signal?: AbortSignal,
  ): Promise<{ tool: ResolvedTool | null; candidates: string[] }> {
    const unqualified: ResolvedTool[] = [];

    for (const backend of this.backends) {
      const descriptor = await backend.getDescriptor(signal);
      if (!isInvokable(descriptor)) continue;

      for (const action of await backend.getActions(signal)) {
        if (eqIgnoreCase(McpToolName.encode(descriptor.name, action.actionId), toolName)) {
          return { tool: { backend, descriptor, action }, candidates: [] };   // qualified wins
        }
        if (eqIgnoreCase(action.actionId, toolName) ||
            eqIgnoreCase(McpToolName.encodeActionSegment(action.actionId), toolName)) {
          unqualified.push({ backend, descriptor, action });
        }
      }
    }

    // Only accept the fallback when it is unambiguous — two nodes exposing the same action id
    // must be disambiguated by the caller, not guessed at here.
    if (unqualified.length === 1) return { tool: unqualified[0]!, candidates: [] };
    return {
      tool: null,
      candidates: unqualified.map((c) => McpToolName.encode(c.descriptor.name, c.action.actionId)),
    };
  }

  /**
   * Turn an NWP result into an MCP `tools/call` response.
   *
   * The split here is the §16.3 rule that both predecessors got wrong: an auth, limit, or
   * unsupported failure MUST surface as a JSON-RPC *error*. Ordinary domain failures stay as
   * `isError: true` content, which is what MCP intends that flag for.
   */
  private toToolCallResponse(request: BridgeJsonRpcRequest, result: NwpResult): BridgeJsonRpcResponse {
    if (!result.ok && mustBeProtocolError(result.npsStatus)) {
      return jsonRpcError(request, toJsonRpc(result.npsStatus),
        result.message ?? result.npsStatus ?? "NWP dispatch failed.",
        { status: result.npsStatus, error: result.nwpError });
    }
    const text = result.ok
      ? JSON.stringify(result.payload ?? {})
      : JSON.stringify({ status: result.npsStatus, error: result.nwpError, message: result.message });
    return jsonRpcSuccess(request, {
      isError: !result.ok,
      content: [{ type: "text", text }],
    });
  }

  // ── resources/list ─────────────────────────────────────────────────────────

  private async listResources(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const resources: Record<string, unknown>[] = [];
    for (const backend of this.backends) {
      const d = await backend.getDescriptor(signal);
      if (!isQueryable(d)) continue;
      resources.push({
        uri: `nwp://${d.name}/`,
        name: d.displayName ?? d.name,
        description: d.description ?? `NWP ${d.role} Node '${d.name}' — read to query.`,
        mimeType: "application/json",
      });
    }
    // An empty set is conformant: §16.1.2 requires the METHOD to be served, not that a
    // Memory Node exist behind it.
    return { resources };
  }

  // ── resources/read ─────────────────────────────────────────────────────────

  private async readResource(
    request: BridgeJsonRpcRequest, signal?: AbortSignal,
  ): Promise<BridgeJsonRpcResponse> {
    const params = asObject(request.params);
    const uriRaw = params?.["uri"];
    if (typeof uriRaw !== "string" || uriRaw.trim() === "") {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        "MCP resources/read requires params.uri.");
    }

    let uri: URL;
    try {
      uri = new URL(uriRaw);
    } catch {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        `Resource URI '${uriRaw}' must be of the form nwp://<node>/.`);
    }
    if (uri.protocol !== "nwp:") {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        `Resource URI '${uriRaw}' must be of the form nwp://<node>/.`);
    }

    // `new URL("nwp://x/")` does not populate `host` for a non-special scheme in every
    // runtime, so recover the authority from the raw string when needed.
    const host = uri.hostname || uriRaw.slice("nwp://".length).split("/")[0]!;
    const backend = await this.resolveBackend(host, signal);
    if (backend === null) {
      return jsonRpcError(request,
        // §16.3: an unknown *resource* is a bad argument, not a missing method.
        BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        `Resource '${uriRaw}' is not exposed by this Bridge Node.`,
        { error: BridgeErrorCodes.SERVER_TOOL_NOT_FOUND, uri: uriRaw });
    }

    const result = await backend.query({ limit: this.options.resourceReadLimit }, signal);
    if (!result.ok) {
      return jsonRpcError(request,
        toJsonRpc(result.npsStatus, /* resourceRead */ true),
        result.message ?? result.npsStatus ?? "NWP query failed.",
        { status: result.npsStatus, error: result.nwpError });
    }

    return jsonRpcSuccess(request, {
      contents: [{
        uri: uriRaw,
        mimeType: "application/json",
        text: JSON.stringify(result.payload ?? {}),
      }],
    });
  }

  private async resolveBackend(nodeName: string, signal?: AbortSignal): Promise<INwpBackend | null> {
    for (const backend of this.backends) {
      const d = await backend.getDescriptor(signal);
      if (eqIgnoreCase(d.name, nodeName)) return backend;
    }
    return null;
  }

  // ── stdio transport ────────────────────────────────────────────────────────

  /**
   * Serve MCP over stdio: line-delimited JSON-RPC in, one line of JSON-RPC out per request.
   * This is the transport most MCP clients launch a server with, so it is part of the
   * inbound profile, not an extra.
   *
   * Blank lines are skipped; the loop ends when `lines` is exhausted; a request that does not
   * deserialise into an envelope gets `-32600`; a parse exception gets `-32700` with `id: null`.
   */
  async runStdio(
    lines: AsyncIterable<string>,
    write: (line: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const line of lines) {
      if (signal?.aborted) break;
      if (line.trim() === "") continue;

      let response: BridgeJsonRpcResponse;
      try {
        const parsed = JSON.parse(line) as unknown;
        const request = asObject(parsed);
        response = (request === null || typeof request["method"] !== "string")
          ? jsonRpcError(null, BridgeJsonRpcErrorCodes.INVALID_REQUEST, "JSON-RPC request is required.")
          : await this.dispatch(request as unknown as BridgeJsonRpcRequest, signal);
      } catch (e) {
        response = jsonRpcError(null, BridgeJsonRpcErrorCodes.PARSE_ERROR,
          e instanceof Error ? e.message : String(e));
      }
      await write(JSON.stringify(response) + "\n");
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
