// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** NIP error code wire constants — mirror of `spec/error-codes.md` NIP section. */

// ── Cert verification (v1 + v2) ──────────────────────────────────────────────
export const CERT_EXPIRED            = "NIP-CERT-EXPIRED" as const;
export const CERT_REVOKED            = "NIP-CERT-REVOKED" as const;
export const CERT_SIGNATURE_INVALID  = "NIP-CERT-SIGNATURE-INVALID" as const;
export const CERT_UNTRUSTED_ISSUER   = "NIP-CERT-UNTRUSTED-ISSUER" as const;
export const CERT_CAPABILITY_MISSING = "NIP-CERT-CAPABILITY-MISSING" as const;
export const CERT_SCOPE_VIOLATION    = "NIP-CERT-SCOPE-VIOLATION" as const;

// ── CA service ───────────────────────────────────────────────────────────────
export const CA_NID_NOT_FOUND          = "NIP-CA-NID-NOT-FOUND" as const;
export const CA_NID_ALREADY_EXISTS     = "NIP-CA-NID-ALREADY-EXISTS" as const;
export const CA_SERIAL_DUPLICATE       = "NIP-CA-SERIAL-DUPLICATE" as const;
export const CA_RENEWAL_TOO_EARLY      = "NIP-CA-RENEWAL-TOO-EARLY" as const;
export const CA_SCOPE_EXPANSION_DENIED = "NIP-CA-SCOPE-EXPANSION-DENIED" as const;

export const OCSP_UNAVAILABLE     = "NIP-OCSP-UNAVAILABLE" as const;

// ── TrustFrame (NPS-3 §5.2) ──────────────────────────────────────────────────
export const TRUST_FRAME_INVALID                = "NIP-TRUST-FRAME-INVALID" as const;
export const TRUST_FRAME_EXPIRED                = "NIP-TRUST-FRAME-EXPIRED" as const;
export const TRUST_FRAME_GRANTOR_REVOKED        = "NIP-TRUST-FRAME-GRANTOR-REVOKED" as const;
export const TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR  = "NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR" as const;
export const TRUST_FRAME_NODES_PATTERN_INVALID  = "NIP-TRUST-FRAME-NODES-PATTERN-INVALID" as const;

// ── RevokeFrame (NPS-3 §5.3) ─────────────────────────────────────────────────
export const REVOKE_FRAME_INVALID              = "NIP-REVOKE-FRAME-INVALID" as const;
export const REVOKE_FRAME_UNAUTHORIZED_ISSUER  = "NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER" as const;
export const REVOKE_FRAME_SERIAL_MISMATCH      = "NIP-REVOKE-FRAME-SERIAL-MISMATCH" as const;
export const REVOKE_FRAME_REASON_UNKNOWN       = "NIP-REVOKE-FRAME-REASON-UNKNOWN" as const;

// ── RFC-0003 (assurance level) ───────────────────────────────────────────────
export const ASSURANCE_MISMATCH = "NIP-ASSURANCE-MISMATCH" as const;
export const ASSURANCE_UNKNOWN  = "NIP-ASSURANCE-UNKNOWN" as const;

// ── RFC-0004 (reputation log) ────────────────────────────────────────────────
export const REPUTATION_ENTRY_INVALID      = "NIP-REPUTATION-ENTRY-INVALID" as const;
export const REPUTATION_LOG_UNREACHABLE    = "NIP-REPUTATION-LOG-UNREACHABLE" as const;
export const REPUTATION_GOSSIP_FORK        = "NIP-REPUTATION-GOSSIP-FORK" as const;
export const REPUTATION_GOSSIP_SIG_INVALID = "NIP-REPUTATION-GOSSIP-SIG-INVALID" as const;

// ── RFC-0002 (X.509 + ACME) ──────────────────────────────────────────────────
export const CERT_FORMAT_INVALID       = "NIP-CERT-FORMAT-INVALID" as const;
export const CERT_EKU_MISSING          = "NIP-CERT-EKU-MISSING" as const;
export const CERT_SUBJECT_NID_MISMATCH = "NIP-CERT-SUBJECT-NID-MISMATCH" as const;
export const ACME_CHALLENGE_FAILED     = "NIP-ACME-CHALLENGE-FAILED" as const;

// ── NPS-CR-0003 (group / session NID lineage) ────────────────────────────────
export const CA_GROUP_REVOKED         = "NIP-CA-GROUP-REVOKED" as const;
export const CA_PARENT_NOT_FOUND      = "NIP-CA-PARENT-NOT-FOUND" as const;
export const CA_PARENT_NOT_GROUP      = "NIP-CA-PARENT-NOT-GROUP" as const;
export const CA_SESSION_VALIDITY_INVALID = "NIP-CA-SESSION-VALIDITY-INVALID" as const;
export const CA_JWS_INVALID           = "NIP-CA-JWS-INVALID" as const;
export const CA_JWS_EXPIRED           = "NIP-CA-JWS-EXPIRED" as const;
export const CERT_PARENT_REVOKED      = "NIP-CERT-PARENT-REVOKED" as const;

// ── OCSP staple (referenced in task) ────────────────────────────────────────
export const OCSP_STAPLE_EXPIRED      = "NIP-OCSP-STAPLE-EXPIRED" as const;

// ── NIP v0.10 — node_roles ───────────────────────────────────────────────────
export const CERT_NODE_ROLES_MISMATCH = "NIP-CERT-NODE-ROLES-MISMATCH" as const;

// ── NPS-CR-0005 (RA enrollment tiers) ────────────────────────────────────────
export const RA_TOKEN_INVALID    = "NIP-RA-TOKEN-INVALID" as const;
export const RA_TOKEN_EXPIRED     = "NIP-RA-TOKEN-EXPIRED" as const;
export const RA_NID_NOT_ALLOWED   = "NIP-RA-NID-NOT-ALLOWED" as const;
export const RA_PENDING_REJECTED  = "NIP-RA-PENDING-REJECTED" as const;

/** Maps each NIP error code to its NPS status code. */
export const NIP_ERROR_TO_NPS_STATUS: Record<string, string> = {
  "NIP-CERT-EXPIRED":                      "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-REVOKED":                      "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-SIGNATURE-INVALID":            "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-UNTRUSTED-ISSUER":             "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-CAPABILITY-MISSING":           "NPS-AUTH-FORBIDDEN",
  "NIP-CERT-SCOPE-VIOLATION":              "NPS-AUTH-FORBIDDEN",
  "NIP-CA-NID-NOT-FOUND":                  "NPS-CLIENT-NOT-FOUND",
  "NIP-CA-NID-ALREADY-EXISTS":             "NPS-CLIENT-CONFLICT",
  "NIP-CA-SERIAL-DUPLICATE":               "NPS-CLIENT-CONFLICT",
  "NIP-CA-RENEWAL-TOO-EARLY":              "NPS-CLIENT-BAD-PARAM",
  "NIP-CA-SCOPE-EXPANSION-DENIED":         "NPS-AUTH-FORBIDDEN",
  "NIP-OCSP-UNAVAILABLE":                  "NPS-SERVER-UNAVAILABLE",
  "NIP-TRUST-FRAME-INVALID":               "NPS-CLIENT-BAD-FRAME",
  "NIP-TRUST-FRAME-EXPIRED":               "NPS-AUTH-UNAUTHENTICATED",
  "NIP-TRUST-FRAME-GRANTOR-REVOKED":       "NPS-AUTH-UNAUTHENTICATED",
  "NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR": "NPS-AUTH-FORBIDDEN",
  "NIP-TRUST-FRAME-NODES-PATTERN-INVALID": "NPS-CLIENT-BAD-FRAME",
  "NIP-REVOKE-FRAME-INVALID":              "NPS-CLIENT-BAD-FRAME",
  "NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER":  "NPS-AUTH-FORBIDDEN",
  "NIP-REVOKE-FRAME-SERIAL-MISMATCH":      "NPS-CLIENT-BAD-PARAM",
  "NIP-REVOKE-FRAME-REASON-UNKNOWN":       "NPS-CLIENT-BAD-FRAME",
  "NIP-ASSURANCE-MISMATCH":                "NPS-CLIENT-BAD-FRAME",
  "NIP-ASSURANCE-UNKNOWN":                 "NPS-CLIENT-BAD-FRAME",
  "NIP-REPUTATION-ENTRY-INVALID":          "NPS-CLIENT-BAD-FRAME",
  "NIP-REPUTATION-LOG-UNREACHABLE":        "NPS-DOWNSTREAM-UNAVAILABLE",
  "NIP-REPUTATION-GOSSIP-FORK":            "NPS-SERVER-INTERNAL",
  "NIP-REPUTATION-GOSSIP-SIG-INVALID":     "NPS-CLIENT-BAD-FRAME",
  "NIP-CERT-FORMAT-INVALID":               "NPS-CLIENT-BAD-FRAME",
  "NIP-CERT-EKU-MISSING":                  "NPS-CLIENT-BAD-FRAME",
  "NIP-CERT-SUBJECT-NID-MISMATCH":         "NPS-CLIENT-BAD-FRAME",
  "NIP-ACME-CHALLENGE-FAILED":             "NPS-CLIENT-BAD-FRAME",
  "NIP-CA-GROUP-REVOKED":                  "NPS-AUTH-FORBIDDEN",
  "NIP-CA-PARENT-NOT-FOUND":               "NPS-CLIENT-NOT-FOUND",
  "NIP-CA-PARENT-NOT-GROUP":               "NPS-CLIENT-BAD-PARAM",
  "NIP-CA-SESSION-VALIDITY-INVALID":       "NPS-CLIENT-BAD-PARAM",
  "NIP-CA-JWS-INVALID":                    "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CA-JWS-EXPIRED":                    "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-PARENT-REVOKED":               "NPS-AUTH-UNAUTHENTICATED",
  "NIP-OCSP-STAPLE-EXPIRED":               "NPS-AUTH-UNAUTHENTICATED",
  "NIP-CERT-NODE-ROLES-MISMATCH":          "NPS-AUTH-FORBIDDEN",
  "NIP-RA-TOKEN-INVALID":                  "NPS-AUTH-UNAUTHENTICATED",
  "NIP-RA-TOKEN-EXPIRED":                  "NPS-AUTH-UNAUTHENTICATED",
  "NIP-RA-NID-NOT-ALLOWED":                "NPS-AUTH-FORBIDDEN",
  "NIP-RA-PENDING-REJECTED":               "NPS-AUTH-FORBIDDEN",
};
