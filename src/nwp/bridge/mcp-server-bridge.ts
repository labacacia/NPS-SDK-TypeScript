// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { NpsFrame } from "../../core/codec.js";
import { ErrorFrame } from "../../ncp/frames.js";
import { ActionFrame } from "../frames.js";
import { BridgeErrorCodes } from "./errors.js";
import { BridgeFrameJson } from "./frame-json.js";
import {
  BridgeJsonRpc,
  BridgeJsonRpcErrorCodes,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import { McpServerProtocol, type McpToolCallParams } from "./mcp-types.js";
import {
  effectiveToolName,
  type BridgeServerAction,
  type IBridgeServerActionInvoker,
  type ResolvedBridgeServerOptions,
} from "./server-options.js";

/** Inbound MCP adapter that exposes local NPS actions as MCP tools. */
export class McpServerBridge {
  constructor(
    private readonly options: ResolvedBridgeServerOptions,
    private readonly invoker: IBridgeServerActionInvoker,
  ) {}

  /** Dispatch one MCP JSON-RPC request. */
  async dispatch(request: BridgeJsonRpcRequest): Promise<BridgeJsonRpcResponse> {
    switch (request.method) {
      case "initialize":
        return BridgeJsonRpc.success(request, this.initialize());
      case "tools/list":
        return BridgeJsonRpc.success(request, this.listTools());
      case "tools/call":
        return await this.callTool(request);
      case "ping":
        return BridgeJsonRpc.success(request, {});
      default:
        return BridgeJsonRpc.error(
          request,
          BridgeJsonRpcErrorCodes.MethodNotFound,
          `MCP method '${request.method}' is not supported by NWP Bridge server.`,
        );
    }
  }

  private initialize() {
    return {
      protocolVersion: McpServerProtocol.Version,
      serverInfo: { name: this.options.serverName, version: this.options.serverVersion },
      capabilities: { tools: { listChanged: false } },
    };
  }

  private listTools() {
    return {
      tools: this.options.actions.map((action) => ({
        name: effectiveToolName(action),
        description: action.description,
        inputSchema: action.inputSchema ?? defaultInputSchema(),
      })),
    };
  }

  private async callTool(request: BridgeJsonRpcRequest): Promise<BridgeJsonRpcResponse> {
    if (request.params === undefined || request.params === null) {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.InvalidParams,
        "MCP tools/call requires params.",
      );
    }

    const call = request.params as McpToolCallParams;
    if (call == null || !call.name || call.name.trim() === "") {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.InvalidParams,
        "MCP tools/call params.name is required.",
      );
    }

    const action = this.resolveAction(call.name);
    if (action === undefined) {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.ToolNotFound,
        `MCP tool '${call.name}' is not exposed by NWP Bridge server.`,
        { error: BridgeErrorCodes.ServerToolNotFound, tool: call.name },
      );
    }

    const frame = new ActionFrame(action.actionId, call.arguments ?? undefined, action.async ?? false);

    try {
      const result = await this.invoker.invoke(frame);
      return BridgeJsonRpc.success(request, toToolResult(result));
    } catch (err) {
      return BridgeJsonRpc.success(
        request,
        toToolResult(
          new ErrorFrame(
            "NPS-SERVER-ERROR",
            BridgeErrorCodes.ServerDispatchFailed,
            err instanceof Error ? err.message : String(err),
          ),
        ),
      );
    }
  }

  private resolveAction(toolName: string): BridgeServerAction | undefined {
    return this.options.actions.find(
      (action) =>
        effectiveToolName(action).toLowerCase() === toolName.toLowerCase() ||
        action.actionId.toLowerCase() === toolName.toLowerCase(),
    );
  }
}

function toToolResult(frame: NpsFrame) {
  const isError = frame instanceof ErrorFrame;
  return {
    content: [{ type: "text", text: BridgeFrameJson.serialize(frame) }],
    isError,
  };
}

function defaultInputSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: true };
}
