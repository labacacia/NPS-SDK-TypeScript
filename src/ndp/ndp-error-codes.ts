// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// NDP Error Codes — all 13 protocol error codes per spec/error-codes.md

export const NDP_RESOLVE_NOT_FOUND         = "NDP-RESOLVE-NOT-FOUND" as const;
export const NDP_RESOLVE_AMBIGUOUS         = "NDP-RESOLVE-AMBIGUOUS" as const;
export const NDP_RESOLVE_TIMEOUT           = "NDP-RESOLVE-TIMEOUT" as const;
export const NDP_RESOLVE_STALE             = "NDP-RESOLVE-STALE" as const;
export const NDP_ANNOUNCE_SIGNATURE_INVALID = "NDP-ANNOUNCE-SIGNATURE-INVALID" as const;
export const NDP_ANNOUNCE_NID_MISMATCH     = "NDP-ANNOUNCE-NID-MISMATCH" as const;
/** NPS-CR-0001: legacy "gateway" role removed; use "anchor" or "bridge" */
export const NDP_ANNOUNCE_ROLE_REMOVED     = "NDP-ANNOUNCE-ROLE-REMOVED" as const;
export const NDP_ANNOUNCE_ROLE_UNKNOWN     = "NDP-ANNOUNCE-ROLE-UNKNOWN" as const;
export const NDP_ANNOUNCE_CONFLICT         = "NDP-ANNOUNCE-CONFLICT" as const;
export const NDP_ANNOUNCE_PROFILE_VIOLATION = "NDP-ANNOUNCE-PROFILE-VIOLATION" as const;
export const NDP_GRAPH_SEQ_ROLLBACK        = "NDP-GRAPH-SEQ-ROLLBACK" as const;
export const NDP_GRAPH_SEQ_GAP             = "NDP-GRAPH-SEQ-GAP" as const;
export const NDP_ISSUER_NOT_ALLOWED        = "NDP-ISSUER-NOT-ALLOWED" as const;
export const NDP_CA_ATTEST_REQUIRED        = "NDP-CA-ATTEST-REQUIRED" as const;
export const NDP_REGISTRY_UNAVAILABLE      = "NDP-REGISTRY-UNAVAILABLE" as const;

// ── Referenced in task description (extra codes) ──────────────────────────────
/** DAG graph structure is invalid */
export const NDP_GRAPH_INVALID             = "NDP-GRAPH-INVALID" as const;
/** DAG graph exceeds maximum permitted size */
export const NDP_GRAPH_TOO_LARGE           = "NDP-GRAPH-TOO-LARGE" as const;
/** Federation resolution resulted in a routing loop */
export const NDP_FEDERATION_LOOP           = "NDP-FEDERATION-LOOP" as const;
/** Announce not received within heartbeat_interval_ms × 3 dead-peer threshold (v0.9) */
export const NDP_ANNOUNCE_STALE            = "NDP-ANNOUNCE-STALE" as const;

// ── Multi-Anchor HA (NPS-CR-0009) ────────────────────────────────────────────
/**
 * Two or more live Anchor announcements advertise the same top `cluster_epoch` for one
 * `cluster_anchor` cluster (split-brain). The Registry refuses to resolve arbitrarily.
 */
export const NDP_CLUSTER_SPLIT             = "NDP-CLUSTER-SPLIT" as const;

/** Maps each NDP error code to its NPS status code. */
export const NDP_ERROR_TO_NPS_STATUS: Record<string, string> = {
  "NDP-RESOLVE-NOT-FOUND":          "NPS-CLIENT-NOT-FOUND",
  "NDP-RESOLVE-AMBIGUOUS":          "NPS-CLIENT-CONFLICT",
  "NDP-RESOLVE-TIMEOUT":            "NPS-SERVER-TIMEOUT",
  "NDP-RESOLVE-STALE":              "NPS-CLIENT-NOT-FOUND",
  "NDP-ANNOUNCE-SIGNATURE-INVALID": "NPS-AUTH-UNAUTHENTICATED",
  "NDP-ANNOUNCE-NID-MISMATCH":      "NPS-CLIENT-BAD-FRAME",
  "NDP-ANNOUNCE-ROLE-REMOVED":      "NPS-CLIENT-BAD-FRAME",
  "NDP-ANNOUNCE-ROLE-UNKNOWN":      "NPS-CLIENT-BAD-FRAME",
  "NDP-ANNOUNCE-CONFLICT":          "NPS-CLIENT-CONFLICT",
  "NDP-ANNOUNCE-PROFILE-VIOLATION": "NPS-AUTH-FORBIDDEN",
  "NDP-GRAPH-SEQ-ROLLBACK":         "NPS-CLIENT-BAD-FRAME",
  "NDP-GRAPH-SEQ-GAP":              "NPS-STREAM-SEQ-GAP",
  "NDP-ISSUER-NOT-ALLOWED":         "NPS-AUTH-FORBIDDEN",
  "NDP-CA-ATTEST-REQUIRED":         "NPS-AUTH-UNAUTHENTICATED",
  "NDP-REGISTRY-UNAVAILABLE":       "NPS-SERVER-UNAVAILABLE",
  "NDP-GRAPH-INVALID":              "NPS-CLIENT-BAD-FRAME",
  "NDP-GRAPH-TOO-LARGE":            "NPS-LIMIT-PAYLOAD",
  "NDP-FEDERATION-LOOP":            "NPS-CLIENT-CONFLICT",
  "NDP-ANNOUNCE-STALE":             "NPS-CLIENT-NOT-FOUND",
  "NDP-CLUSTER-SPLIT":              "NPS-CLIENT-CONFLICT",
};
