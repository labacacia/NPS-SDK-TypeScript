// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// NPS native status codes — per spec/status-codes.md

/** NPS native status code constants. */
export const NpsStatusCodes = {
  // Success
  NPS_OK: "NPS-OK",
  NPS_OK_ACCEPTED: "NPS-OK-ACCEPTED",
  NPS_OK_NO_CONTENT: "NPS-OK-NO-CONTENT",

  // Auth
  NPS_AUTH_UNAUTHENTICATED: "NPS-AUTH-UNAUTHENTICATED",
  NPS_AUTH_FORBIDDEN: "NPS-AUTH-FORBIDDEN",

  // Client errors
  NPS_CLIENT_BAD_FRAME: "NPS-CLIENT-BAD-FRAME",
  NPS_CLIENT_BAD_PARAM: "NPS-CLIENT-BAD-PARAM",
  NPS_CLIENT_NOT_FOUND: "NPS-CLIENT-NOT-FOUND",
  NPS_CLIENT_CONFLICT: "NPS-CLIENT-CONFLICT",
  NPS_CLIENT_GONE: "NPS-CLIENT-GONE",
  NPS_CLIENT_UNPROCESSABLE: "NPS-CLIENT-UNPROCESSABLE",
  /** Rate-limited by reputation policy (NPS-RFC-0005) */
  NPS_CLIENT_RATE_LIMITED: "NPS-CLIENT-RATE-LIMITED",
  /** Request body exceeds the effective CGN budget (token-budget.md §7.4) */
  NPS_CLIENT_REQUEST_TOO_LARGE: "NPS-CLIENT-REQUEST-TOO-LARGE",

  // Server errors
  NPS_SERVER_INTERNAL: "NPS-SERVER-INTERNAL",
  NPS_SERVER_UNAVAILABLE: "NPS-SERVER-UNAVAILABLE",
  NPS_SERVER_TIMEOUT: "NPS-SERVER-TIMEOUT",
  NPS_SERVER_ENCODING_UNSUPPORTED: "NPS-SERVER-ENCODING-UNSUPPORTED",
  NPS_SERVER_UNSUPPORTED: "NPS-SERVER-UNSUPPORTED",
  /** A required downstream service is unreachable (NPS-RFC-0004) */
  NPS_DOWNSTREAM_UNAVAILABLE: "NPS-DOWNSTREAM-UNAVAILABLE",

  // Stream
  NPS_STREAM_SEQ_GAP: "NPS-STREAM-SEQ-GAP",
  NPS_STREAM_NOT_FOUND: "NPS-STREAM-NOT-FOUND",
  NPS_STREAM_LIMIT: "NPS-STREAM-LIMIT",

  // Limit
  NPS_LIMIT_RATE: "NPS-LIMIT-RATE",
  NPS_LIMIT_BUDGET: "NPS-LIMIT-BUDGET",
  NPS_LIMIT_PAYLOAD: "NPS-LIMIT-PAYLOAD",
  NPS_LIMIT_RESOURCE: "NPS-LIMIT-RESOURCE",
  /** Generic quota/resource limit exceeded */
  NPS_LIMIT_EXCEEDED: "NPS-LIMIT-EXCEEDED",

  // Protocol
  NPS_PROTO_VERSION_INCOMPATIBLE: "NPS-PROTO-VERSION-INCOMPATIBLE",
  /** Native-mode connection preamble invalid — not emitted on wire (NPS-RFC-0001) */
  NPS_PROTO_PREAMBLE_INVALID: "NPS-PROTO-PREAMBLE-INVALID",
} as const;

export type NpsStatusCode = (typeof NpsStatusCodes)[keyof typeof NpsStatusCodes];

/**
 * HTTP status code mapping for NPS status codes (HTTP / Overlay mode only).
 * Native mode uses NPS status codes directly.
 */
export const HTTP_STATUS_MAP: Record<NpsStatusCode, number> = {
  "NPS-OK":                          200,
  "NPS-OK-ACCEPTED":                 202,
  "NPS-OK-NO-CONTENT":               204,

  "NPS-AUTH-UNAUTHENTICATED":        401,
  "NPS-AUTH-FORBIDDEN":              403,

  "NPS-CLIENT-BAD-FRAME":            400,
  "NPS-CLIENT-BAD-PARAM":            400,
  "NPS-CLIENT-NOT-FOUND":            404,
  "NPS-CLIENT-CONFLICT":             409,
  "NPS-CLIENT-GONE":                 410,
  "NPS-CLIENT-UNPROCESSABLE":        422,
  "NPS-CLIENT-RATE-LIMITED":         429,
  "NPS-CLIENT-REQUEST-TOO-LARGE":    413,

  "NPS-SERVER-INTERNAL":             500,
  "NPS-SERVER-UNAVAILABLE":          503,
  "NPS-SERVER-TIMEOUT":              504,
  "NPS-SERVER-ENCODING-UNSUPPORTED": 415,
  "NPS-SERVER-UNSUPPORTED":          501,
  "NPS-DOWNSTREAM-UNAVAILABLE":      502,

  "NPS-STREAM-SEQ-GAP":              422,
  "NPS-STREAM-NOT-FOUND":            404,
  "NPS-STREAM-LIMIT":                429,

  "NPS-LIMIT-RATE":                  429,
  "NPS-LIMIT-BUDGET":                429,
  "NPS-LIMIT-PAYLOAD":               413,
  "NPS-LIMIT-RESOURCE":              429,
  "NPS-LIMIT-EXCEEDED":              429,

  "NPS-PROTO-VERSION-INCOMPATIBLE":  426,
  "NPS-PROTO-PREAMBLE-INVALID":      400,
};

/**
 * Returns the HTTP status code for the given NPS status code.
 * Falls back to 500 for unknown codes.
 */
export function toHttpStatus(code: NpsStatusCode): number {
  return HTTP_STATUS_MAP[code] ?? 500;
}
