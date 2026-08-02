// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** JSON-RPC 2.0 envelopes shared by the inbound MCP and A2A Bridge servers. */

export interface BridgeJsonRpcRequest {
  jsonrpc?: string;
  /** Request id. `null` / absent indicates a notification. */
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface BridgeJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface BridgeJsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: BridgeJsonRpcError;
}

/**
 * Standard JSON-RPC 2.0 codes plus the Bridge server application codes.
 * The NPS status each maps from is normative — see NWP §16.3 / {@link toJsonRpc}.
 */
export const BridgeJsonRpcErrorCodes = {
  // ── Standard JSON-RPC 2.0 ──────────────────────────────────────────────────
  PARSE_ERROR:     -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS:  -32602,
  INTERNAL_ERROR:  -32603,

  // ── Application-defined (JSON-RPC reserves -32000..-32099) ────────────────
  /** The upstream external service failed or was unreachable. */
  UPSTREAM_ERROR:  -32000,
  /** Maps from `NPS-AUTH-UNAUTHENTICATED`. */
  UNAUTHENTICATED: -32001,
  /** Maps from `NPS-AUTH-FORBIDDEN`. MUST NOT be collapsed onto -32001. */
  FORBIDDEN:       -32003,
  /** Maps from `NPS-CLIENT-CONFLICT`. */
  CONFLICT:        -32004,
  /** Maps from `NPS-LIMIT-RATE` / `-BUDGET` / `-PAYLOAD`. */
  LIMIT_EXCEEDED:  -32005,
} as const;

/**
 * Retired by NPS-CR-0010. An unknown tool maps to `METHOD_NOT_FOUND` (-32601) per NWP §16.3 —
 * that is what an MCP client already understands. -32002 is left **reserved rather than
 * reused**, so a client pinned to the alpha.15 behaviour cannot silently misread a different
 * error as a missing tool. Exported only so ports and tests can assert it is never emitted.
 *
 * @deprecated Do not emit.
 */
export const RETIRED_TOOL_NOT_FOUND_CODE = -32002;

export function jsonRpcSuccess(request: BridgeJsonRpcRequest, result: unknown): BridgeJsonRpcResponse {
  return { jsonrpc: "2.0", id: request.id ?? null, result };
}

export function jsonRpcError(
  request: BridgeJsonRpcRequest | null,
  code: number,
  message: string,
  data?: unknown,
): BridgeJsonRpcResponse {
  const response: BridgeJsonRpcResponse = {
    jsonrpc: "2.0",
    id: request?.id ?? null,
    error: { code, message },
  };
  if (data !== undefined) response.error!.data = data;
  return response;
}

/** Whether a value looks like a well-formed JSON-RPC request envelope. */
export function isJsonRpcRequest(value: unknown): value is BridgeJsonRpcRequest {
  return typeof value === "object" && value !== null &&
    typeof (value as Record<string, unknown>)["method"] === "string";
}
