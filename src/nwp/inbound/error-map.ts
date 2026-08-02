// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * The normative NPS ↔ foreign-protocol error mapping of NWP §16.3 (NPS-CR-0010).
 *
 * Through alpha.15 this mapping was implemented twice per protocol — once in the outbound
 * dispatcher, once in the then-separate ingress package — and the two copies drifted. §16.3
 * makes the mapping normative and requires a **single** implementation to serve both
 * directions and all three protocols. This is that implementation; no inbound or outbound
 * path may hand-roll its own.
 */

import { NpsStatusCodes } from "../../core/status-codes.js";
import * as ErrorCodes from "../nwp-error-codes.js";
import { BridgeJsonRpcErrorCodes } from "./json-rpc.js";

const S = NpsStatusCodes;

/**
 * NWP Bridge error codes, grouped by the direction they apply to.
 * Statuses removed by NPS-CR-0010 that a port MUST NOT reintroduce:
 * `NPS-SERVER-NOT-IMPLEMENTED`, `NPS-SERVER-ERROR`, `NPS-CLIENT-UNAUTHORIZED`,
 * `NPS-CLIENT-BAD-REQUEST`, `NPS-SERVER-UPSTREAM-FAILED`.
 */
export const BridgeErrorCodes = {
  /** Both directions (new in NPS-CR-0010). */
  DIRECTION_UNSUPPORTED:  ErrorCodes.NWP_BRIDGE_DIRECTION_UNSUPPORTED,
  /** Outbound. */
  TARGET_INVALID:         ErrorCodes.NWP_BRIDGE_TARGET_INVALID,
  /** Outbound. */
  PROTOCOL_UNSUPPORTED:   ErrorCodes.NWP_BRIDGE_PROTOCOL_UNSUPPORTED,
  /** Outbound. */
  ENDPOINT_INVALID:       ErrorCodes.NWP_BRIDGE_ENDPOINT_INVALID,
  /** Outbound. */
  UPSTREAM_FAILED:        ErrorCodes.NWP_BRIDGE_UPSTREAM_FAILED,
  /** Inbound. */
  SERVER_TOOL_NOT_FOUND:  ErrorCodes.NWP_BRIDGE_SERVER_TOOL_NOT_FOUND,
  /** Inbound. */
  SERVER_DISPATCHER_MISSING: ErrorCodes.NWP_BRIDGE_SERVER_DISPATCHER_MISSING,
  /** Inbound. */
  SERVER_DISPATCH_FAILED: ErrorCodes.NWP_BRIDGE_SERVER_DISPATCH_FAILED,
} as const;

/**
 * NPS status → JSON-RPC 2.0 error code (MCP, A2A).
 *
 * @param resourceRead when true the request was a `resources/read`, where an unknown target
 * is a bad *argument* (-32602) rather than a missing *method* (-32601). §16.3 calls this
 * distinction out explicitly and it is the only param-sensitive row.
 */
export function toJsonRpc(npsStatus: string | undefined, resourceRead = false): number {
  const C = BridgeJsonRpcErrorCodes;
  switch (npsStatus) {
    case S.NPS_CLIENT_BAD_FRAME:
      return C.INVALID_REQUEST;

    case S.NPS_CLIENT_BAD_PARAM:
    case S.NPS_CLIENT_UNPROCESSABLE:
    case S.NPS_CLIENT_GONE:
      return C.INVALID_PARAMS;

    case S.NPS_CLIENT_NOT_FOUND:
      return resourceRead ? C.INVALID_PARAMS : C.METHOD_NOT_FOUND;

    case S.NPS_CLIENT_CONFLICT:
      return C.CONFLICT;

    case S.NPS_AUTH_UNAUTHENTICATED:
      return C.UNAUTHENTICATED;
    case S.NPS_AUTH_FORBIDDEN:
      return C.FORBIDDEN;

    case S.NPS_LIMIT_RATE:
    case S.NPS_LIMIT_BUDGET:
    case S.NPS_LIMIT_PAYLOAD:
      return C.LIMIT_EXCEEDED;

    // "Not implemented" reads to an MCP client as a method it cannot call.
    case S.NPS_SERVER_UNSUPPORTED:
      return C.METHOD_NOT_FOUND;

    default:
      return C.INTERNAL_ERROR;
  }
}

/** NPS status → canonical gRPC status-code name. */
export function toGrpcStatus(npsStatus: string | undefined): string {
  switch (npsStatus) {
    case S.NPS_CLIENT_BAD_FRAME:
    case S.NPS_CLIENT_BAD_PARAM:
    case S.NPS_CLIENT_UNPROCESSABLE:
      return "INVALID_ARGUMENT";

    case S.NPS_CLIENT_NOT_FOUND:
    case S.NPS_CLIENT_GONE:
      return "NOT_FOUND";

    case S.NPS_CLIENT_CONFLICT:      return "ABORTED";
    case S.NPS_AUTH_UNAUTHENTICATED: return "UNAUTHENTICATED";
    case S.NPS_AUTH_FORBIDDEN:       return "PERMISSION_DENIED";

    case S.NPS_LIMIT_RATE:
    case S.NPS_LIMIT_BUDGET:
    case S.NPS_LIMIT_PAYLOAD:
      return "RESOURCE_EXHAUSTED";

    case S.NPS_SERVER_UNSUPPORTED: return "UNIMPLEMENTED";
    case S.NPS_SERVER_INTERNAL:    return "INTERNAL";

    case S.NPS_SERVER_UNAVAILABLE:
    case S.NPS_DOWNSTREAM_UNAVAILABLE:
      return "UNAVAILABLE";

    case S.NPS_SERVER_TIMEOUT: return "DEADLINE_EXCEEDED";

    default: return "INTERNAL";
  }
}

/**
 * HTTP status → NPS status. The inverse direction, used when translating an upstream
 * response back into NWP frames. §16.3 requires the **most specific** NPS status where the
 * inverse is not injective — never a blanket `NPS-SERVER-INTERNAL`.
 */
export function fromHttpStatus(httpStatus: number): string {
  switch (httpStatus) {
    case 400: return S.NPS_CLIENT_BAD_PARAM;
    case 401: return S.NPS_AUTH_UNAUTHENTICATED;
    case 403: return S.NPS_AUTH_FORBIDDEN;
    case 404: return S.NPS_CLIENT_NOT_FOUND;
    case 408: return S.NPS_SERVER_TIMEOUT;
    case 409: return S.NPS_CLIENT_CONFLICT;
    case 410: return S.NPS_CLIENT_GONE;
    case 413: return S.NPS_LIMIT_PAYLOAD;
    case 415: return S.NPS_SERVER_ENCODING_UNSUPPORTED;
    case 422: return S.NPS_CLIENT_UNPROCESSABLE;
    case 429: return S.NPS_LIMIT_RATE;
    case 501: return S.NPS_SERVER_UNSUPPORTED;
    case 502:
    case 504: return S.NPS_DOWNSTREAM_UNAVAILABLE;
    case 503: return S.NPS_SERVER_UNAVAILABLE;
    default:
      if (httpStatus >= 500) return S.NPS_SERVER_INTERNAL;
      if (httpStatus >= 400) return S.NPS_CLIENT_BAD_PARAM;
      return S.NPS_OK;
  }
}

/**
 * Reverse of {@link toJsonRpc}: a foreign JSON-RPC error code → the most specific NPS status.
 * Used by an **outbound** Bridge translating an upstream MCP/A2A server's error back into NWP.
 */
export function fromJsonRpc(jsonRpcCode: number): string {
  const C = BridgeJsonRpcErrorCodes;
  switch (jsonRpcCode) {
    case C.PARSE_ERROR:      return S.NPS_CLIENT_BAD_FRAME;
    case C.INVALID_REQUEST:  return S.NPS_CLIENT_BAD_FRAME;
    case C.METHOD_NOT_FOUND: return S.NPS_CLIENT_NOT_FOUND;
    case C.INVALID_PARAMS:   return S.NPS_CLIENT_BAD_PARAM;
    case C.INTERNAL_ERROR:   return S.NPS_SERVER_INTERNAL;
    case C.UNAUTHENTICATED:  return S.NPS_AUTH_UNAUTHENTICATED;
    case C.FORBIDDEN:        return S.NPS_AUTH_FORBIDDEN;
    case C.CONFLICT:         return S.NPS_CLIENT_CONFLICT;
    case C.LIMIT_EXCEEDED:   return S.NPS_LIMIT_RATE;
    case C.UPSTREAM_ERROR:   return S.NPS_DOWNSTREAM_UNAVAILABLE;
    default:                 return S.NPS_SERVER_INTERNAL;
  }
}

/** Reverse of {@link toGrpcStatus}. Accepts the canonical `UPPER_SNAKE` spelling. */
export function fromGrpcStatus(grpcStatus: string | undefined): string {
  switch (grpcStatus?.toUpperCase()) {
    case "OK":                  return S.NPS_OK;
    case "INVALID_ARGUMENT":    return S.NPS_CLIENT_BAD_PARAM;
    case "FAILED_PRECONDITION": return S.NPS_CLIENT_UNPROCESSABLE;
    case "NOT_FOUND":           return S.NPS_CLIENT_NOT_FOUND;
    case "ALREADY_EXISTS":
    case "ABORTED":             return S.NPS_CLIENT_CONFLICT;
    case "UNAUTHENTICATED":     return S.NPS_AUTH_UNAUTHENTICATED;
    case "PERMISSION_DENIED":   return S.NPS_AUTH_FORBIDDEN;
    case "RESOURCE_EXHAUSTED":  return S.NPS_LIMIT_RATE;
    case "UNIMPLEMENTED":       return S.NPS_SERVER_UNSUPPORTED;
    case "UNAVAILABLE":         return S.NPS_SERVER_UNAVAILABLE;
    case "DEADLINE_EXCEEDED":   return S.NPS_SERVER_TIMEOUT;
    case "INTERNAL":
    case "UNKNOWN":
    case "DATA_LOSS":           return S.NPS_SERVER_INTERNAL;
    default:                    return S.NPS_SERVER_INTERNAL;
  }
}

/**
 * Whether a failure MUST be surfaced as a protocol-level error rather than a successful
 * response carrying an error payload.
 *
 * The set is **infrastructure failures**: auth, limit, unsupported, and the server /
 * downstream / timeout classes. These mean *the tool did not run* — an MCP client must see a
 * protocol error, not a tool that "returned" an error string. Both pre-CR-0010
 * implementations returned them as a successful result with `isError: true`, which lets a
 * client mistake a 403 for a tool that merely returned unhappy text. Genuine tool-domain
 * failures (the `NPS-CLIENT-*` classes) stay as `isError: true` content, which is what MCP's
 * flag is for.
 */
export function mustBeProtocolError(npsStatus: string | undefined): boolean {
  switch (npsStatus) {
    case S.NPS_AUTH_UNAUTHENTICATED:
    case S.NPS_AUTH_FORBIDDEN:
    case S.NPS_LIMIT_RATE:
    case S.NPS_LIMIT_BUDGET:
    case S.NPS_LIMIT_PAYLOAD:
    case S.NPS_SERVER_UNSUPPORTED:
    case S.NPS_SERVER_INTERNAL:
    case S.NPS_SERVER_UNAVAILABLE:
    case S.NPS_SERVER_TIMEOUT:
    case S.NPS_DOWNSTREAM_UNAVAILABLE:
      return true;
    default:
      return false;
  }
}

/** Everything above, also reachable as one namespace object. */
export const BridgeErrorMap = {
  toJsonRpc,
  toGrpcStatus,
  fromHttpStatus,
  fromJsonRpc,
  fromGrpcStatus,
  mustBeProtocolError,
} as const;
