// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// NWP Error Codes — canonical wire constants from spec/error-codes.md

// ── Auth / NID ────────────────────────────────────────────────────────────────
export const NWP_AUTH_NID_SCOPE_VIOLATION     = "NWP-AUTH-NID-SCOPE-VIOLATION" as const;
export const NWP_AUTH_NID_EXPIRED             = "NWP-AUTH-NID-EXPIRED" as const;
export const NWP_AUTH_NID_REVOKED             = "NWP-AUTH-NID-REVOKED" as const;
export const NWP_AUTH_NID_UNTRUSTED_ISSUER    = "NWP-AUTH-NID-UNTRUSTED-ISSUER" as const;
export const NWP_AUTH_NID_CAPABILITY_MISSING  = "NWP-AUTH-NID-CAPABILITY-MISSING" as const;
export const NWP_AUTH_ASSURANCE_TOO_LOW       = "NWP-AUTH-ASSURANCE-TOO-LOW" as const;
/** @deprecated RFC-0005: use NWP_REPUTATION_REJECTED / NWP_REPUTATION_BANNED */
export const NWP_AUTH_REPUTATION_BLOCKED      = "NWP-AUTH-REPUTATION-BLOCKED" as const;

// ── Reputation (RFC-0005) ─────────────────────────────────────────────────────
export const NWP_REPUTATION_THROTTLED         = "NWP-REPUTATION-THROTTLED" as const;
export const NWP_REPUTATION_REJECTED          = "NWP-REPUTATION-REJECTED" as const;
export const NWP_REPUTATION_BANNED            = "NWP-REPUTATION-BANNED" as const;

// ── Query ─────────────────────────────────────────────────────────────────────
export const NWP_QUERY_FILTER_INVALID         = "NWP-QUERY-FILTER-INVALID" as const;
export const NWP_QUERY_FIELD_UNKNOWN          = "NWP-QUERY-FIELD-UNKNOWN" as const;
export const NWP_QUERY_CURSOR_INVALID         = "NWP-QUERY-CURSOR-INVALID" as const;
export const NWP_QUERY_REGEX_UNSAFE           = "NWP-QUERY-REGEX-UNSAFE" as const;
export const NWP_QUERY_VECTOR_UNSUPPORTED     = "NWP-QUERY-VECTOR-UNSUPPORTED" as const;
export const NWP_QUERY_AGGREGATE_UNSUPPORTED  = "NWP-QUERY-AGGREGATE-UNSUPPORTED" as const;
export const NWP_QUERY_AGGREGATE_INVALID      = "NWP-QUERY-AGGREGATE-INVALID" as const;
export const NWP_QUERY_STREAM_UNSUPPORTED     = "NWP-QUERY-STREAM-UNSUPPORTED" as const;

// ── Action ────────────────────────────────────────────────────────────────────
export const NWP_ACTION_NOT_FOUND             = "NWP-ACTION-NOT-FOUND" as const;
export const NWP_ACTION_PARAMS_INVALID        = "NWP-ACTION-PARAMS-INVALID" as const;
export const NWP_ACTION_IDEMPOTENCY_CONFLICT  = "NWP-ACTION-IDEMPOTENCY-CONFLICT" as const;
export const NWP_LLM_CONTEXT_NOT_FOUND       = "NWP-LLM-CONTEXT-NOT-FOUND" as const;
export const NWP_LLM_CONTEXT_EXPIRED         = "NWP-LLM-CONTEXT-EXPIRED" as const;
export const NWP_LLM_CONTEXT_VERSION_CONFLICT = "NWP-LLM-CONTEXT-VERSION-CONFLICT" as const;
export const NWP_LLM_CONTEXT_BINDING_MISMATCH = "NWP-LLM-CONTEXT-BINDING-MISMATCH" as const;
export const NWP_LLM_CONTEXT_FORBIDDEN       = "NWP-LLM-CONTEXT-FORBIDDEN" as const;
export const NWP_LLM_CONTEXT_LIMIT_EXCEEDED  = "NWP-LLM-CONTEXT-LIMIT-EXCEEDED" as const;
export const NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED = "NWP-LLM-CONTEXT-OPERATION-UNSUPPORTED" as const;

// ── Async task ────────────────────────────────────────────────────────────────
export const NWP_TASK_NOT_FOUND               = "NWP-TASK-NOT-FOUND" as const;
export const NWP_TASK_ALREADY_CANCELLED       = "NWP-TASK-ALREADY-CANCELLED" as const;
export const NWP_TASK_ALREADY_COMPLETED       = "NWP-TASK-ALREADY-COMPLETED" as const;
export const NWP_TASK_ALREADY_FAILED          = "NWP-TASK-ALREADY-FAILED" as const;

// ── Subscribe ─────────────────────────────────────────────────────────────────
export const NWP_SUBSCRIBE_STREAM_NOT_FOUND   = "NWP-SUBSCRIBE-STREAM-NOT-FOUND" as const;
export const NWP_SUBSCRIBE_LIMIT_EXCEEDED     = "NWP-SUBSCRIBE-LIMIT-EXCEEDED" as const;
export const NWP_SUBSCRIBE_FILTER_UNSUPPORTED = "NWP-SUBSCRIBE-FILTER-UNSUPPORTED" as const;
export const NWP_SUBSCRIBE_INTERRUPTED        = "NWP-SUBSCRIBE-INTERRUPTED" as const;
export const NWP_SUBSCRIBE_SEQ_TOO_OLD        = "NWP-SUBSCRIBE-SEQ-TOO-OLD" as const;
export const NWP_SUBSCRIBE_LEASE_INVALID      = "NWP-SUBSCRIBE-LEASE-INVALID" as const;
export const NWP_SUBSCRIBE_LEASE_EXPIRED      = "NWP-SUBSCRIBE-LEASE-EXPIRED" as const;

// ── Budget / limits ───────────────────────────────────────────────────────────
export const NWP_BUDGET_EXCEEDED              = "NWP-BUDGET-EXCEEDED" as const;
export const NWP_CGN_LIMIT_EXCEEDED           = "NWP-CGN-LIMIT-EXCEEDED" as const;
export const NWP_DEPTH_EXCEEDED               = "NWP-DEPTH-EXCEEDED" as const;
export const NWP_RATE_LIMIT_EXCEEDED          = "NWP-RATE-LIMIT-EXCEEDED" as const;

// ── Graph / node ──────────────────────────────────────────────────────────────
export const NWP_GRAPH_CYCLE                  = "NWP-GRAPH-CYCLE" as const;
export const NWP_NODE_UNAVAILABLE             = "NWP-NODE-UNAVAILABLE" as const;

// ── Manifest ──────────────────────────────────────────────────────────────────
export const NWP_MANIFEST_VERSION_UNSUPPORTED = "NWP-MANIFEST-VERSION-UNSUPPORTED" as const;
export const NWP_MANIFEST_NODE_TYPE_REMOVED   = "NWP-MANIFEST-NODE-TYPE-REMOVED" as const;
export const NWP_MANIFEST_NODE_TYPE_UNKNOWN   = "NWP-MANIFEST-NODE-TYPE-UNKNOWN" as const;

// ── Reserved / unsupported ────────────────────────────────────────────────────
export const NWP_RESERVED_TYPE_UNSUPPORTED    = "NWP-RESERVED-TYPE-UNSUPPORTED" as const;

// ── HTTP binding / advertised capability ─────────────────────────────────────
export const NWP_HTTP_ORIGIN_FORBIDDEN        = "NWP-HTTP-ORIGIN-FORBIDDEN" as const;
export const NWP_HTTP_CONTENT_TYPE_UNSUPPORTED = "NWP-HTTP-CONTENT-TYPE-UNSUPPORTED" as const;
export const NWP_HTTP_ACCEPT_UNSATISFIABLE    = "NWP-HTTP-ACCEPT-UNSATISFIABLE" as const;
export const NWP_HTTP_REQUEST_ID_MISMATCH     = "NWP-HTTP-REQUEST-ID-MISMATCH" as const;
export const NWP_HTTP_FRAME_BODY_MALFORMED    = "NWP-HTTP-FRAME-BODY-MALFORMED" as const;
export const NWP_HTTP_BODY_TOO_LARGE          = "NWP-HTTP-BODY-TOO-LARGE" as const;
export const NWP_CAPABILITY_ADVERTISED_UNIMPLEMENTED = "NWP-CAPABILITY-ADVERTISED-UNIMPLEMENTED" as const;

// ── Topology (NPS-CR-0002) ────────────────────────────────────────────────────
export const NWP_TOPOLOGY_UNAUTHORIZED        = "NWP-TOPOLOGY-UNAUTHORIZED" as const;
export const NWP_TOPOLOGY_UNSUPPORTED_SCOPE   = "NWP-TOPOLOGY-UNSUPPORTED-SCOPE" as const;
export const NWP_TOPOLOGY_DEPTH_UNSUPPORTED   = "NWP-TOPOLOGY-DEPTH-UNSUPPORTED" as const;
export const NWP_TOPOLOGY_FILTER_UNSUPPORTED  = "NWP-TOPOLOGY-FILTER-UNSUPPORTED" as const;

// ── Multi-Anchor HA (NPS-CR-0009) ─────────────────────────────────────────────
/** A topology write reached a standby, or the active owner while read-only-degraded. */
export const NWP_ANCHOR_NOT_LEADER            = "NWP-ANCHOR-NOT-LEADER" as const;
/**
 * An inbound frame carries a `cluster_epoch` **strictly greater** than the receiver's own:
 * the receiver is a superseded leader and self-fences. `<=` own epoch is NOT an error.
 */
export const NWP_ANCHOR_EPOCH_FENCED          = "NWP-ANCHOR-EPOCH-FENCED" as const;

// ── Bridge (NPS-CR-0001 outbound, NPS-CR-0010 inbound) ────────────────────────
/** The request targets a protocol/direction pair this Bridge Node never declared. */
export const NWP_BRIDGE_DIRECTION_UNSUPPORTED = "NWP-BRIDGE-DIRECTION-UNSUPPORTED" as const;
/** Outbound: the invocation carries no valid `bridge_target`. */
export const NWP_BRIDGE_TARGET_INVALID        = "NWP-BRIDGE-TARGET-INVALID" as const;
/** Outbound: `bridge_target.protocol` is well-formed but has no registered dispatcher. */
export const NWP_BRIDGE_PROTOCOL_UNSUPPORTED  = "NWP-BRIDGE-PROTOCOL-UNSUPPORTED" as const;
/** Outbound: the target endpoint is invalid or disallowed. */
export const NWP_BRIDGE_ENDPOINT_INVALID      = "NWP-BRIDGE-ENDPOINT-INVALID" as const;
/** Outbound: the external call failed or returned an unusable response. */
export const NWP_BRIDGE_UPSTREAM_FAILED       = "NWP-BRIDGE-UPSTREAM-FAILED" as const;
/** Inbound: the foreign client named a tool / action / resource that is not exposed. */
export const NWP_BRIDGE_SERVER_TOOL_NOT_FOUND = "NWP-BRIDGE-SERVER-TOOL-NOT-FOUND" as const;
/** Inbound: no backend was configured for the NPS node the Bridge fronts (deployment fault). */
export const NWP_BRIDGE_SERVER_DISPATCHER_MISSING = "NWP-BRIDGE-SERVER-DISPATCHER-MISSING" as const;
/** Inbound: dispatch to the fronted NPS node failed unexpectedly. */
export const NWP_BRIDGE_SERVER_DISPATCH_FAILED = "NWP-BRIDGE-SERVER-DISPATCH-FAILED" as const;

/** Maps each NWP error code to its NPS status code. */
export const NWP_ERROR_TO_NPS_STATUS: Record<string, string> = {
  "NWP-AUTH-NID-SCOPE-VIOLATION":     "NPS-AUTH-FORBIDDEN",
  "NWP-AUTH-NID-EXPIRED":             "NPS-AUTH-UNAUTHENTICATED",
  "NWP-AUTH-NID-REVOKED":             "NPS-AUTH-UNAUTHENTICATED",
  "NWP-AUTH-NID-UNTRUSTED-ISSUER":    "NPS-AUTH-UNAUTHENTICATED",
  "NWP-AUTH-NID-CAPABILITY-MISSING":  "NPS-AUTH-FORBIDDEN",
  "NWP-AUTH-ASSURANCE-TOO-LOW":       "NPS-AUTH-FORBIDDEN",
  "NWP-AUTH-REPUTATION-BLOCKED":      "NPS-AUTH-FORBIDDEN",
  "NWP-REPUTATION-THROTTLED":         "NPS-CLIENT-RATE-LIMITED",
  "NWP-REPUTATION-REJECTED":          "NPS-AUTH-FORBIDDEN",
  "NWP-REPUTATION-BANNED":            "NPS-AUTH-FORBIDDEN",
  "NWP-QUERY-FILTER-INVALID":         "NPS-CLIENT-BAD-PARAM",
  "NWP-QUERY-FIELD-UNKNOWN":          "NPS-CLIENT-BAD-PARAM",
  "NWP-QUERY-CURSOR-INVALID":         "NPS-CLIENT-BAD-PARAM",
  "NWP-QUERY-REGEX-UNSAFE":           "NPS-CLIENT-BAD-PARAM",
  "NWP-QUERY-VECTOR-UNSUPPORTED":     "NPS-SERVER-UNSUPPORTED",
  "NWP-QUERY-AGGREGATE-UNSUPPORTED":  "NPS-SERVER-UNSUPPORTED",
  "NWP-QUERY-AGGREGATE-INVALID":      "NPS-CLIENT-BAD-PARAM",
  "NWP-QUERY-STREAM-UNSUPPORTED":     "NPS-SERVER-UNSUPPORTED",
  "NWP-ACTION-NOT-FOUND":             "NPS-CLIENT-NOT-FOUND",
  "NWP-ACTION-PARAMS-INVALID":        "NPS-CLIENT-UNPROCESSABLE",
  "NWP-ACTION-IDEMPOTENCY-CONFLICT":  "NPS-CLIENT-CONFLICT",
  "NWP-LLM-CONTEXT-NOT-FOUND":       "NPS-CLIENT-NOT-FOUND",
  "NWP-LLM-CONTEXT-EXPIRED":         "NPS-CLIENT-GONE",
  "NWP-LLM-CONTEXT-VERSION-CONFLICT": "NPS-CLIENT-CONFLICT",
  "NWP-LLM-CONTEXT-BINDING-MISMATCH": "NPS-CLIENT-CONFLICT",
  "NWP-LLM-CONTEXT-FORBIDDEN":       "NPS-AUTH-FORBIDDEN",
  "NWP-LLM-CONTEXT-LIMIT-EXCEEDED":  "NPS-LIMIT-RESOURCE",
  "NWP-LLM-CONTEXT-OPERATION-UNSUPPORTED": "NPS-SERVER-UNSUPPORTED",
  "NWP-TASK-NOT-FOUND":               "NPS-CLIENT-NOT-FOUND",
  "NWP-TASK-ALREADY-CANCELLED":       "NPS-CLIENT-CONFLICT",
  "NWP-TASK-ALREADY-COMPLETED":       "NPS-CLIENT-CONFLICT",
  "NWP-TASK-ALREADY-FAILED":          "NPS-CLIENT-CONFLICT",
  "NWP-SUBSCRIBE-STREAM-NOT-FOUND":   "NPS-CLIENT-NOT-FOUND",
  "NWP-SUBSCRIBE-LIMIT-EXCEEDED":     "NPS-LIMIT-EXCEEDED",
  "NWP-SUBSCRIBE-FILTER-UNSUPPORTED": "NPS-SERVER-UNSUPPORTED",
  "NWP-SUBSCRIBE-INTERRUPTED":        "NPS-SERVER-UNAVAILABLE",
  "NWP-SUBSCRIBE-SEQ-TOO-OLD":        "NPS-CLIENT-CONFLICT",
  "NWP-SUBSCRIBE-LEASE-INVALID":      "NPS-CLIENT-BAD-PARAM",
  "NWP-SUBSCRIBE-LEASE-EXPIRED":      "NPS-CLIENT-GONE",
  "NWP-BUDGET-EXCEEDED":              "NPS-LIMIT-BUDGET",
  "NWP-CGN-LIMIT-EXCEEDED":           "NPS-CLIENT-REQUEST-TOO-LARGE",
  "NWP-DEPTH-EXCEEDED":               "NPS-CLIENT-BAD-PARAM",
  "NWP-GRAPH-CYCLE":                  "NPS-CLIENT-UNPROCESSABLE",
  "NWP-NODE-UNAVAILABLE":             "NPS-SERVER-UNAVAILABLE",
  "NWP-MANIFEST-VERSION-UNSUPPORTED": "NPS-CLIENT-BAD-PARAM",
  "NWP-MANIFEST-NODE-TYPE-REMOVED":   "NPS-CLIENT-BAD-FRAME",
  "NWP-MANIFEST-NODE-TYPE-UNKNOWN":   "NPS-CLIENT-BAD-FRAME",
  "NWP-RATE-LIMIT-EXCEEDED":          "NPS-LIMIT-RATE",
  "NWP-RESERVED-TYPE-UNSUPPORTED":    "NPS-SERVER-UNSUPPORTED",
  "NWP-HTTP-ORIGIN-FORBIDDEN":        "NPS-AUTH-FORBIDDEN",
  "NWP-HTTP-CONTENT-TYPE-UNSUPPORTED": "NPS-CLIENT-BAD-FRAME",
  "NWP-HTTP-ACCEPT-UNSATISFIABLE":    "NPS-CLIENT-BAD-PARAM",
  "NWP-HTTP-REQUEST-ID-MISMATCH":     "NPS-CLIENT-BAD-PARAM",
  "NWP-HTTP-FRAME-BODY-MALFORMED":    "NPS-CLIENT-BAD-FRAME",
  "NWP-HTTP-BODY-TOO-LARGE":          "NPS-LIMIT-PAYLOAD",
  "NWP-CAPABILITY-ADVERTISED-UNIMPLEMENTED": "NPS-SERVER-UNSUPPORTED",
  "NWP-TOPOLOGY-UNAUTHORIZED":        "NPS-AUTH-FORBIDDEN",
  "NWP-TOPOLOGY-UNSUPPORTED-SCOPE":   "NPS-CLIENT-BAD-PARAM",
  "NWP-TOPOLOGY-DEPTH-UNSUPPORTED":   "NPS-CLIENT-BAD-PARAM",
  "NWP-TOPOLOGY-FILTER-UNSUPPORTED":  "NPS-CLIENT-BAD-PARAM",
  "NWP-ANCHOR-NOT-LEADER":            "NPS-CLIENT-CONFLICT",
  "NWP-ANCHOR-EPOCH-FENCED":          "NPS-CLIENT-CONFLICT",
  "NWP-BRIDGE-DIRECTION-UNSUPPORTED": "NPS-SERVER-UNSUPPORTED",
  "NWP-BRIDGE-TARGET-INVALID":        "NPS-CLIENT-UNPROCESSABLE",
  "NWP-BRIDGE-PROTOCOL-UNSUPPORTED":  "NPS-SERVER-UNSUPPORTED",
  "NWP-BRIDGE-ENDPOINT-INVALID":      "NPS-CLIENT-UNPROCESSABLE",
  "NWP-BRIDGE-UPSTREAM-FAILED":       "NPS-DOWNSTREAM-UNAVAILABLE",
  "NWP-BRIDGE-SERVER-TOOL-NOT-FOUND": "NPS-CLIENT-NOT-FOUND",
  "NWP-BRIDGE-SERVER-DISPATCHER-MISSING": "NPS-SERVER-INTERNAL",
  "NWP-BRIDGE-SERVER-DISPATCH-FAILED": "NPS-SERVER-INTERNAL",
};
