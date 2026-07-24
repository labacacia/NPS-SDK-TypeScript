// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** JSON-RPC 2.0 request envelope used by MCP and A2A Bridge servers. */
export interface BridgeJsonRpcRequest {
  jsonrpc?: string;
  /** Request id. `null`/absent indicates a notification. */
  id?: unknown;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response envelope used by MCP and A2A Bridge servers. */
export interface BridgeJsonRpcResponse {
  jsonrpc: string;
  id?: unknown;
  result?: unknown;
  error?: BridgeJsonRpcError;
}

/** JSON-RPC 2.0 error object. */
export interface BridgeJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC error codes plus Bridge server application codes. */
export const BridgeJsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  UpstreamError: -32000,
  ToolNotFound: -32002,
} as const;

/** Envelope helpers (port of the internal .NET `BridgeJsonRpc`). */
export const BridgeJsonRpc = {
  success(request: BridgeJsonRpcRequest, result: unknown): BridgeJsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: clone(request.id),
      result,
    };
  },

  error(
    idOrRequest: BridgeJsonRpcRequest | unknown,
    code: number,
    message: string,
    data?: unknown,
  ): BridgeJsonRpcResponse {
    const id = isRequest(idOrRequest) ? idOrRequest.id : idOrRequest;
    const response: BridgeJsonRpcResponse = {
      jsonrpc: "2.0",
      id: clone(id),
      error: { code, message },
    };
    if (data !== undefined && data !== null) response.error!.data = data;
    return response;
  },
};

function isRequest(value: unknown): value is BridgeJsonRpcRequest {
  return typeof value === "object" && value !== null && "method" in value;
}

function clone(id: unknown): unknown {
  if (id === undefined) return null;
  return id;
}
