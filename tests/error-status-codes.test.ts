// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// Issue #68 — Full parity tests for error/status constants across all protocols.

import { describe, expect, it } from "vitest";

// Core status codes
import {
  NpsStatusCodes,
  HTTP_STATUS_MAP,
  toHttpStatus,
  type NpsStatusCode,
} from "../src/core/status-codes.js";

// NCP
import {
  NCP_ERROR_CODES,
  NCP_ERROR_TO_NPS_STATUS,
} from "../src/ncp/ncp-error-codes.js";

// NWP
import {
  NWP_ERROR_TO_NPS_STATUS,
  NWP_AUTH_NID_SCOPE_VIOLATION,
  NWP_AUTH_NID_EXPIRED,
  NWP_REPUTATION_THROTTLED,
  NWP_CGN_LIMIT_EXCEEDED,
  NWP_SUBSCRIBE_LIMIT_EXCEEDED,
  NWP_TOPOLOGY_UNAUTHORIZED,
  NWP_TOPOLOGY_FILTER_UNSUPPORTED,
  NWP_HTTP_ORIGIN_FORBIDDEN,
} from "../src/nwp/nwp-error-codes.js";

// NIP
import {
  NIP_ERROR_TO_NPS_STATUS,
  TRUST_FRAME_INVALID,
  TRUST_FRAME_EXPIRED,
  TRUST_FRAME_GRANTOR_REVOKED,
  TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR,
  TRUST_FRAME_NODES_PATTERN_INVALID,
  REVOKE_FRAME_INVALID,
  REVOKE_FRAME_UNAUTHORIZED_ISSUER,
  REVOKE_FRAME_SERIAL_MISMATCH,
  REVOKE_FRAME_REASON_UNKNOWN,
  CA_GROUP_REVOKED,
  CA_PARENT_NOT_FOUND,
  CA_PARENT_NOT_GROUP,
  CA_SESSION_VALIDITY_INVALID,
  CA_JWS_INVALID,
  CA_JWS_EXPIRED,
  CERT_PARENT_REVOKED,
  OCSP_STAPLE_EXPIRED,
} from "../src/nip/error-codes.js";

// NDP
import {
  NDP_ERROR_TO_NPS_STATUS,
  NDP_RESOLVE_NOT_FOUND,
  NDP_RESOLVE_AMBIGUOUS,
  NDP_RESOLVE_TIMEOUT,
  NDP_RESOLVE_STALE,
  NDP_ANNOUNCE_SIGNATURE_INVALID,
  NDP_ANNOUNCE_NID_MISMATCH,
  NDP_ANNOUNCE_ROLE_REMOVED,
  NDP_ANNOUNCE_ROLE_UNKNOWN,
  NDP_ANNOUNCE_CONFLICT,
  NDP_ANNOUNCE_PROFILE_VIOLATION,
  NDP_ANNOUNCE_STALE,
  NDP_GRAPH_SEQ_ROLLBACK,
  NDP_GRAPH_SEQ_GAP,
  NDP_ISSUER_NOT_ALLOWED,
  NDP_CA_ATTEST_REQUIRED,
  NDP_REGISTRY_UNAVAILABLE,
  NDP_GRAPH_INVALID,
  NDP_GRAPH_TOO_LARGE,
  NDP_FEDERATION_LOOP,
} from "../src/ndp/ndp-error-codes.js";

// NOP
import {
  NOP_ERROR_TO_NPS_STATUS,
  NOP_TASK_NOT_FOUND,
  NOP_TASK_TIMEOUT,
  NOP_TASK_DAG_INVALID,
  NOP_TASK_DAG_CYCLE,
  NOP_TASK_DAG_TOO_LARGE,
  NOP_TASK_ALREADY_COMPLETED,
  NOP_TASK_CANCELLED,
  NOP_DELEGATE_SCOPE_VIOLATION,
  NOP_DELEGATE_REJECTED,
  NOP_DELEGATE_CHAIN_TOO_DEEP,
  NOP_DELEGATE_TIMEOUT,
  NOP_SYNC_TIMEOUT,
  NOP_SYNC_DEPENDENCY_FAILED,
  NOP_STREAM_SEQ_GAP,
  NOP_STREAM_NID_MISMATCH,
  NOP_RESOURCE_INSUFFICIENT,
  NOP_CONDITION_EVAL_ERROR,
  NOP_INPUT_MAPPING_ERROR,
  NOP_COMPENSATION_FAILED,
  NOP_COMPENSATION_PARTIAL_FAILED,
  NOP_COMPENSATION_NOT_SUPPORTED,
  NOP_STREAM_NAK,
  NOP_CALLBACK_HMAC_MISSING,
} from "../src/nop/nop-error-codes.js";

// ── NPS Status Codes ──────────────────────────────────────────────────────────

describe("NPS status codes — completeness (25 spec codes + extras)", () => {
  const codes = Object.values(NpsStatusCodes);

  it("contains all 3 success codes", () => {
    expect(codes).toContain("NPS-OK");
    expect(codes).toContain("NPS-OK-ACCEPTED");
    expect(codes).toContain("NPS-OK-NO-CONTENT");
  });

  it("contains all 2 auth codes", () => {
    expect(codes).toContain("NPS-AUTH-UNAUTHENTICATED");
    expect(codes).toContain("NPS-AUTH-FORBIDDEN");
  });

  it("contains all 6 client error codes", () => {
    for (const c of [
      "NPS-CLIENT-BAD-FRAME",
      "NPS-CLIENT-BAD-PARAM",
      "NPS-CLIENT-NOT-FOUND",
      "NPS-CLIENT-CONFLICT",
      "NPS-CLIENT-GONE",
      "NPS-CLIENT-UNPROCESSABLE",
    ]) {
      expect(codes).toContain(c);
    }
  });

  it("contains NPS-CLIENT-RATE-LIMITED (referenced in error-codes.md)", () => {
    expect(codes).toContain("NPS-CLIENT-RATE-LIMITED");
  });

  it("contains NPS-CLIENT-REQUEST-TOO-LARGE (referenced in error-codes.md)", () => {
    expect(codes).toContain("NPS-CLIENT-REQUEST-TOO-LARGE");
  });

  it("contains all 6 server error codes including NPS-DOWNSTREAM-UNAVAILABLE", () => {
    for (const c of [
      "NPS-SERVER-INTERNAL",
      "NPS-SERVER-UNAVAILABLE",
      "NPS-SERVER-TIMEOUT",
      "NPS-SERVER-ENCODING-UNSUPPORTED",
      "NPS-SERVER-UNSUPPORTED",
      "NPS-DOWNSTREAM-UNAVAILABLE",
    ]) {
      expect(codes).toContain(c);
    }
  });

  it("contains all 3 stream codes", () => {
    for (const c of [
      "NPS-STREAM-SEQ-GAP",
      "NPS-STREAM-NOT-FOUND",
      "NPS-STREAM-LIMIT",
    ]) {
      expect(codes).toContain(c);
    }
  });

  it("contains all 4 limit codes including NPS-LIMIT-EXCEEDED", () => {
    for (const c of [
      "NPS-LIMIT-RATE",
      "NPS-LIMIT-BUDGET",
      "NPS-LIMIT-PAYLOAD",
      "NPS-LIMIT-EXCEEDED",
    ]) {
      expect(codes).toContain(c);
    }
  });

  it("contains both protocol codes including NPS-PROTO-PREAMBLE-INVALID", () => {
    expect(codes).toContain("NPS-PROTO-VERSION-INCOMPATIBLE");
    expect(codes).toContain("NPS-PROTO-PREAMBLE-INVALID");
  });
});

describe("HTTP_STATUS_MAP", () => {
  it("maps NPS-OK to 200", () => {
    expect(HTTP_STATUS_MAP["NPS-OK"]).toBe(200);
  });

  it("maps NPS-OK-ACCEPTED to 202", () => {
    expect(HTTP_STATUS_MAP["NPS-OK-ACCEPTED"]).toBe(202);
  });

  it("maps NPS-OK-NO-CONTENT to 204", () => {
    expect(HTTP_STATUS_MAP["NPS-OK-NO-CONTENT"]).toBe(204);
  });

  it("maps NPS-AUTH-UNAUTHENTICATED to 401", () => {
    expect(HTTP_STATUS_MAP["NPS-AUTH-UNAUTHENTICATED"]).toBe(401);
  });

  it("maps NPS-AUTH-FORBIDDEN to 403", () => {
    expect(HTTP_STATUS_MAP["NPS-AUTH-FORBIDDEN"]).toBe(403);
  });

  it("maps NPS-CLIENT-NOT-FOUND to 404", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-NOT-FOUND"]).toBe(404);
  });

  it("maps NPS-CLIENT-CONFLICT to 409", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-CONFLICT"]).toBe(409);
  });

  it("maps NPS-CLIENT-GONE to 410", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-GONE"]).toBe(410);
  });

  it("maps NPS-CLIENT-UNPROCESSABLE to 422", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-UNPROCESSABLE"]).toBe(422);
  });

  it("maps NPS-CLIENT-RATE-LIMITED to 429", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-RATE-LIMITED"]).toBe(429);
  });

  it("maps NPS-CLIENT-REQUEST-TOO-LARGE to 413", () => {
    expect(HTTP_STATUS_MAP["NPS-CLIENT-REQUEST-TOO-LARGE"]).toBe(413);
  });

  it("maps NPS-LIMIT-PAYLOAD to 413", () => {
    expect(HTTP_STATUS_MAP["NPS-LIMIT-PAYLOAD"]).toBe(413);
  });

  it("maps NPS-LIMIT-RATE to 429", () => {
    expect(HTTP_STATUS_MAP["NPS-LIMIT-RATE"]).toBe(429);
  });

  it("maps NPS-SERVER-INTERNAL to 500", () => {
    expect(HTTP_STATUS_MAP["NPS-SERVER-INTERNAL"]).toBe(500);
  });

  it("maps NPS-SERVER-UNSUPPORTED to 501", () => {
    expect(HTTP_STATUS_MAP["NPS-SERVER-UNSUPPORTED"]).toBe(501);
  });

  it("maps NPS-DOWNSTREAM-UNAVAILABLE to 502", () => {
    expect(HTTP_STATUS_MAP["NPS-DOWNSTREAM-UNAVAILABLE"]).toBe(502);
  });

  it("maps NPS-SERVER-UNAVAILABLE to 503", () => {
    expect(HTTP_STATUS_MAP["NPS-SERVER-UNAVAILABLE"]).toBe(503);
  });

  it("maps NPS-SERVER-TIMEOUT to 504", () => {
    expect(HTTP_STATUS_MAP["NPS-SERVER-TIMEOUT"]).toBe(504);
  });

  it("maps NPS-SERVER-ENCODING-UNSUPPORTED to 415", () => {
    expect(HTTP_STATUS_MAP["NPS-SERVER-ENCODING-UNSUPPORTED"]).toBe(415);
  });

  it("maps NPS-PROTO-VERSION-INCOMPATIBLE to 426", () => {
    expect(HTTP_STATUS_MAP["NPS-PROTO-VERSION-INCOMPATIBLE"]).toBe(426);
  });

  it("maps NPS-PROTO-PREAMBLE-INVALID to 400", () => {
    expect(HTTP_STATUS_MAP["NPS-PROTO-PREAMBLE-INVALID"]).toBe(400);
  });

  it("maps NPS-STREAM-SEQ-GAP to 422", () => {
    expect(HTTP_STATUS_MAP["NPS-STREAM-SEQ-GAP"]).toBe(422);
  });

  it("maps NPS-STREAM-NOT-FOUND to 404", () => {
    expect(HTTP_STATUS_MAP["NPS-STREAM-NOT-FOUND"]).toBe(404);
  });

  it("maps NPS-STREAM-LIMIT to 429", () => {
    expect(HTTP_STATUS_MAP["NPS-STREAM-LIMIT"]).toBe(429);
  });

  it("covers every NpsStatusCode value", () => {
    for (const code of Object.values(NpsStatusCodes)) {
      expect(HTTP_STATUS_MAP).toHaveProperty(code);
    }
  });
});

describe("toHttpStatus()", () => {
  it("returns correct HTTP code for NPS-OK", () => {
    expect(toHttpStatus("NPS-OK")).toBe(200);
  });

  it("returns correct HTTP code for NPS-SERVER-INTERNAL", () => {
    expect(toHttpStatus("NPS-SERVER-INTERNAL")).toBe(500);
  });

  it("returns correct HTTP code for NPS-AUTH-FORBIDDEN", () => {
    expect(toHttpStatus("NPS-AUTH-FORBIDDEN")).toBe(403);
  });

  it("returns correct HTTP code for NPS-PROTO-VERSION-INCOMPATIBLE", () => {
    expect(toHttpStatus("NPS-PROTO-VERSION-INCOMPATIBLE")).toBe(426);
  });
});

// ── NCP ───────────────────────────────────────────────────────────────────────

describe("NCP error codes — all 17 spec codes present", () => {
  const codes = Object.values(NCP_ERROR_CODES);

  const specCodes = [
    "NCP-ANCHOR-NOT-FOUND",
    "NCP-ANCHOR-SCHEMA-INVALID",
    "NCP-ANCHOR-ID-MISMATCH",
    "NCP-ANCHOR-STALE",
    "NCP-FRAME-UNKNOWN-TYPE",
    "NCP-FRAME-PAYLOAD-TOO-LARGE",
    "NCP-FRAME-FLAGS-INVALID",
    "NCP-STREAM-SEQ-GAP",
    "NCP-STREAM-NOT-FOUND",
    "NCP-STREAM-LIMIT-EXCEEDED",
    "NCP-STREAM-WINDOW-OVERFLOW",
    "NCP-ENCODING-UNSUPPORTED",
    "NCP-DIFF-FORMAT-UNSUPPORTED",
    "NCP-VERSION-INCOMPATIBLE",
    "NCP-ENC-NOT-NEGOTIATED",
    "NCP-ENC-AUTH-FAILED",
    "NCP-PREAMBLE-INVALID",
  ];

  it("contains all 17 spec-defined codes", () => {
    for (const c of specCodes) {
      expect(codes).toContain(c);
    }
  });
});

describe("NCP_ERROR_TO_NPS_STATUS mapping", () => {
  it("NCP-ANCHOR-NOT-FOUND → NPS-CLIENT-NOT-FOUND", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-ANCHOR-NOT-FOUND"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NCP-FRAME-PAYLOAD-TOO-LARGE → NPS-LIMIT-PAYLOAD", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-FRAME-PAYLOAD-TOO-LARGE"]).toBe(
      "NPS-LIMIT-PAYLOAD",
    );
  });

  it("NCP-STREAM-SEQ-GAP → NPS-STREAM-SEQ-GAP", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-STREAM-SEQ-GAP"]).toBe(
      "NPS-STREAM-SEQ-GAP",
    );
  });

  it("NCP-ENCODING-UNSUPPORTED → NPS-SERVER-ENCODING-UNSUPPORTED", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-ENCODING-UNSUPPORTED"]).toBe(
      "NPS-SERVER-ENCODING-UNSUPPORTED",
    );
  });

  it("NCP-VERSION-INCOMPATIBLE → NPS-PROTO-VERSION-INCOMPATIBLE", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-VERSION-INCOMPATIBLE"]).toBe(
      "NPS-PROTO-VERSION-INCOMPATIBLE",
    );
  });

  it("NCP-PREAMBLE-INVALID → NPS-PROTO-PREAMBLE-INVALID", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-PREAMBLE-INVALID"]).toBe(
      "NPS-PROTO-PREAMBLE-INVALID",
    );
  });

  it("NCP-ANCHOR-ID-MISMATCH → NPS-CLIENT-CONFLICT", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-ANCHOR-ID-MISMATCH"]).toBe(
      "NPS-CLIENT-CONFLICT",
    );
  });

  it("NCP-ENC-NOT-NEGOTIATED → NPS-CLIENT-BAD-FRAME", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-ENC-NOT-NEGOTIATED"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("covers all 17 spec codes", () => {
    const specCodes = [
      "NCP-ANCHOR-NOT-FOUND",
      "NCP-ANCHOR-SCHEMA-INVALID",
      "NCP-ANCHOR-ID-MISMATCH",
      "NCP-ANCHOR-STALE",
      "NCP-FRAME-UNKNOWN-TYPE",
      "NCP-FRAME-PAYLOAD-TOO-LARGE",
      "NCP-FRAME-FLAGS-INVALID",
      "NCP-STREAM-SEQ-GAP",
      "NCP-STREAM-NOT-FOUND",
      "NCP-STREAM-LIMIT-EXCEEDED",
      "NCP-STREAM-WINDOW-OVERFLOW",
      "NCP-ENCODING-UNSUPPORTED",
      "NCP-DIFF-FORMAT-UNSUPPORTED",
      "NCP-VERSION-INCOMPATIBLE",
      "NCP-ENC-NOT-NEGOTIATED",
      "NCP-ENC-AUTH-FAILED",
      "NCP-PREAMBLE-INVALID",
    ];
    for (const c of specCodes) {
      expect(NCP_ERROR_TO_NPS_STATUS).toHaveProperty(c);
    }
  });
});

// ── NWP ───────────────────────────────────────────────────────────────────────

describe("NWP error codes — wire value correctness", () => {
  it("NWP_AUTH_NID_SCOPE_VIOLATION has correct wire value", () => {
    expect(NWP_AUTH_NID_SCOPE_VIOLATION).toBe("NWP-AUTH-NID-SCOPE-VIOLATION");
  });

  it("NWP_AUTH_NID_EXPIRED has correct wire value", () => {
    expect(NWP_AUTH_NID_EXPIRED).toBe("NWP-AUTH-NID-EXPIRED");
  });

  it("NWP_REPUTATION_THROTTLED has correct wire value", () => {
    expect(NWP_REPUTATION_THROTTLED).toBe("NWP-REPUTATION-THROTTLED");
  });

  it("NWP_CGN_LIMIT_EXCEEDED has correct wire value", () => {
    expect(NWP_CGN_LIMIT_EXCEEDED).toBe("NWP-CGN-LIMIT-EXCEEDED");
  });

  it("NWP_SUBSCRIBE_LIMIT_EXCEEDED has correct wire value", () => {
    expect(NWP_SUBSCRIBE_LIMIT_EXCEEDED).toBe("NWP-SUBSCRIBE-LIMIT-EXCEEDED");
  });

  it("NWP_TOPOLOGY_UNAUTHORIZED has correct wire value", () => {
    expect(NWP_TOPOLOGY_UNAUTHORIZED).toBe("NWP-TOPOLOGY-UNAUTHORIZED");
  });

  it("NWP_TOPOLOGY_FILTER_UNSUPPORTED has correct wire value", () => {
    expect(NWP_TOPOLOGY_FILTER_UNSUPPORTED).toBe(
      "NWP-TOPOLOGY-FILTER-UNSUPPORTED",
    );
  });

  it("NWP_HTTP_ORIGIN_FORBIDDEN has correct wire value", () => {
    expect(NWP_HTTP_ORIGIN_FORBIDDEN).toBe("NWP-HTTP-ORIGIN-FORBIDDEN");
  });
});

describe("NWP_ERROR_TO_NPS_STATUS mapping — 53 codes", () => {
  const allNwpCodes = [
    "NWP-AUTH-NID-SCOPE-VIOLATION",
    "NWP-AUTH-NID-EXPIRED",
    "NWP-AUTH-NID-REVOKED",
    "NWP-AUTH-NID-UNTRUSTED-ISSUER",
    "NWP-AUTH-NID-CAPABILITY-MISSING",
    "NWP-AUTH-ASSURANCE-TOO-LOW",
    "NWP-AUTH-REPUTATION-BLOCKED",
    "NWP-REPUTATION-THROTTLED",
    "NWP-REPUTATION-REJECTED",
    "NWP-REPUTATION-BANNED",
    "NWP-QUERY-FILTER-INVALID",
    "NWP-QUERY-FIELD-UNKNOWN",
    "NWP-QUERY-CURSOR-INVALID",
    "NWP-QUERY-REGEX-UNSAFE",
    "NWP-QUERY-VECTOR-UNSUPPORTED",
    "NWP-QUERY-AGGREGATE-UNSUPPORTED",
    "NWP-QUERY-AGGREGATE-INVALID",
    "NWP-QUERY-STREAM-UNSUPPORTED",
    "NWP-ACTION-NOT-FOUND",
    "NWP-ACTION-PARAMS-INVALID",
    "NWP-ACTION-IDEMPOTENCY-CONFLICT",
    "NWP-TASK-NOT-FOUND",
    "NWP-TASK-ALREADY-CANCELLED",
    "NWP-TASK-ALREADY-COMPLETED",
    "NWP-TASK-ALREADY-FAILED",
    "NWP-SUBSCRIBE-STREAM-NOT-FOUND",
    "NWP-SUBSCRIBE-LIMIT-EXCEEDED",
    "NWP-SUBSCRIBE-FILTER-UNSUPPORTED",
    "NWP-SUBSCRIBE-INTERRUPTED",
    "NWP-SUBSCRIBE-SEQ-TOO-OLD",
    "NWP-BUDGET-EXCEEDED",
    "NWP-CGN-LIMIT-EXCEEDED",
    "NWP-DEPTH-EXCEEDED",
    "NWP-GRAPH-CYCLE",
    "NWP-NODE-UNAVAILABLE",
    "NWP-MANIFEST-VERSION-UNSUPPORTED",
    "NWP-MANIFEST-NODE-TYPE-REMOVED",
    "NWP-MANIFEST-NODE-TYPE-UNKNOWN",
    "NWP-RATE-LIMIT-EXCEEDED",
    "NWP-RESERVED-TYPE-UNSUPPORTED",
    "NWP-HTTP-ORIGIN-FORBIDDEN",
    "NWP-HTTP-CONTENT-TYPE-UNSUPPORTED",
    "NWP-HTTP-ACCEPT-UNSATISFIABLE",
    "NWP-HTTP-REQUEST-ID-MISMATCH",
    "NWP-HTTP-FRAME-BODY-MALFORMED",
    "NWP-CAPABILITY-ADVERTISED-UNIMPLEMENTED",
    "NWP-TOPOLOGY-UNAUTHORIZED",
    "NWP-TOPOLOGY-UNSUPPORTED-SCOPE",
    "NWP-TOPOLOGY-DEPTH-UNSUPPORTED",
    "NWP-TOPOLOGY-FILTER-UNSUPPORTED",
  ];

  it("covers all 50 spec-defined NWP codes (+ deprecated alias)", () => {
    for (const c of allNwpCodes) {
      expect(NWP_ERROR_TO_NPS_STATUS).toHaveProperty(c);
    }
  });

  it("NWP-AUTH-NID-SCOPE-VIOLATION → NPS-AUTH-FORBIDDEN", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-AUTH-NID-SCOPE-VIOLATION"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NWP-AUTH-NID-EXPIRED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-AUTH-NID-EXPIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NWP-REPUTATION-THROTTLED → NPS-CLIENT-RATE-LIMITED", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-REPUTATION-THROTTLED"]).toBe(
      "NPS-CLIENT-RATE-LIMITED",
    );
  });

  it("NWP-CGN-LIMIT-EXCEEDED → NPS-CLIENT-REQUEST-TOO-LARGE", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-CGN-LIMIT-EXCEEDED"]).toBe(
      "NPS-CLIENT-REQUEST-TOO-LARGE",
    );
  });

  it("NWP-SUBSCRIBE-LIMIT-EXCEEDED → NPS-LIMIT-EXCEEDED", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-SUBSCRIBE-LIMIT-EXCEEDED"]).toBe(
      "NPS-LIMIT-EXCEEDED",
    );
  });

  it("NWP-BUDGET-EXCEEDED → NPS-LIMIT-BUDGET", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-BUDGET-EXCEEDED"]).toBe(
      "NPS-LIMIT-BUDGET",
    );
  });

  it("NWP-RATE-LIMIT-EXCEEDED → NPS-LIMIT-RATE", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-RATE-LIMIT-EXCEEDED"]).toBe(
      "NPS-LIMIT-RATE",
    );
  });

  it("NWP-RESERVED-TYPE-UNSUPPORTED → NPS-SERVER-UNSUPPORTED", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-RESERVED-TYPE-UNSUPPORTED"]).toBe(
      "NPS-SERVER-UNSUPPORTED",
    );
  });

  it("HTTP binding rejection codes map to their canonical NPS statuses", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-HTTP-ORIGIN-FORBIDDEN"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-HTTP-CONTENT-TYPE-UNSUPPORTED"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-HTTP-ACCEPT-UNSATISFIABLE"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-HTTP-REQUEST-ID-MISMATCH"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-HTTP-FRAME-BODY-MALFORMED"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
    expect(
      NWP_ERROR_TO_NPS_STATUS["NWP-CAPABILITY-ADVERTISED-UNIMPLEMENTED"],
    ).toBe("NPS-SERVER-UNSUPPORTED");
  });

  it("NWP-NODE-UNAVAILABLE → NPS-SERVER-UNAVAILABLE", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-NODE-UNAVAILABLE"]).toBe(
      "NPS-SERVER-UNAVAILABLE",
    );
  });

  it("NWP-GRAPH-CYCLE → NPS-CLIENT-UNPROCESSABLE", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-GRAPH-CYCLE"]).toBe(
      "NPS-CLIENT-UNPROCESSABLE",
    );
  });

  it("NWP-TOPOLOGY-UNAUTHORIZED → NPS-AUTH-FORBIDDEN", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-TOPOLOGY-UNAUTHORIZED"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NWP-MANIFEST-NODE-TYPE-REMOVED → NPS-CLIENT-BAD-FRAME", () => {
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-MANIFEST-NODE-TYPE-REMOVED"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });
});

// ── NIP ───────────────────────────────────────────────────────────────────────

describe("NIP error codes — new codes wire values", () => {
  it("TRUST_FRAME_INVALID wire value", () => {
    expect(TRUST_FRAME_INVALID).toBe("NIP-TRUST-FRAME-INVALID");
  });

  it("TRUST_FRAME_EXPIRED wire value", () => {
    expect(TRUST_FRAME_EXPIRED).toBe("NIP-TRUST-FRAME-EXPIRED");
  });

  it("TRUST_FRAME_GRANTOR_REVOKED wire value", () => {
    expect(TRUST_FRAME_GRANTOR_REVOKED).toBe("NIP-TRUST-FRAME-GRANTOR-REVOKED");
  });

  it("TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR wire value", () => {
    expect(TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR).toBe(
      "NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR",
    );
  });

  it("TRUST_FRAME_NODES_PATTERN_INVALID wire value", () => {
    expect(TRUST_FRAME_NODES_PATTERN_INVALID).toBe(
      "NIP-TRUST-FRAME-NODES-PATTERN-INVALID",
    );
  });

  it("REVOKE_FRAME_INVALID wire value", () => {
    expect(REVOKE_FRAME_INVALID).toBe("NIP-REVOKE-FRAME-INVALID");
  });

  it("REVOKE_FRAME_UNAUTHORIZED_ISSUER wire value", () => {
    expect(REVOKE_FRAME_UNAUTHORIZED_ISSUER).toBe(
      "NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER",
    );
  });

  it("REVOKE_FRAME_SERIAL_MISMATCH wire value", () => {
    expect(REVOKE_FRAME_SERIAL_MISMATCH).toBe(
      "NIP-REVOKE-FRAME-SERIAL-MISMATCH",
    );
  });

  it("REVOKE_FRAME_REASON_UNKNOWN wire value", () => {
    expect(REVOKE_FRAME_REASON_UNKNOWN).toBe("NIP-REVOKE-FRAME-REASON-UNKNOWN");
  });

  it("CA_GROUP_REVOKED wire value", () => {
    expect(CA_GROUP_REVOKED).toBe("NIP-CA-GROUP-REVOKED");
  });

  it("CA_PARENT_NOT_FOUND wire value", () => {
    expect(CA_PARENT_NOT_FOUND).toBe("NIP-CA-PARENT-NOT-FOUND");
  });

  it("CA_PARENT_NOT_GROUP wire value", () => {
    expect(CA_PARENT_NOT_GROUP).toBe("NIP-CA-PARENT-NOT-GROUP");
  });

  it("CA_SESSION_VALIDITY_INVALID wire value", () => {
    expect(CA_SESSION_VALIDITY_INVALID).toBe("NIP-CA-SESSION-VALIDITY-INVALID");
  });

  it("CA_JWS_INVALID wire value", () => {
    expect(CA_JWS_INVALID).toBe("NIP-CA-JWS-INVALID");
  });

  it("CA_JWS_EXPIRED wire value", () => {
    expect(CA_JWS_EXPIRED).toBe("NIP-CA-JWS-EXPIRED");
  });

  it("CERT_PARENT_REVOKED wire value", () => {
    expect(CERT_PARENT_REVOKED).toBe("NIP-CERT-PARENT-REVOKED");
  });

  it("OCSP_STAPLE_EXPIRED wire value", () => {
    expect(OCSP_STAPLE_EXPIRED).toBe("NIP-OCSP-STAPLE-EXPIRED");
  });
});

describe("NIP_ERROR_TO_NPS_STATUS mapping — 38+ codes", () => {
  it("NIP-CERT-EXPIRED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CERT-EXPIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-CERT-REVOKED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CERT-REVOKED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-CERT-SCOPE-VIOLATION → NPS-AUTH-FORBIDDEN", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CERT-SCOPE-VIOLATION"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NIP-TRUST-FRAME-INVALID → NPS-CLIENT-BAD-FRAME", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-TRUST-FRAME-INVALID"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("NIP-TRUST-FRAME-EXPIRED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-TRUST-FRAME-EXPIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-TRUST-FRAME-GRANTOR-REVOKED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-TRUST-FRAME-GRANTOR-REVOKED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR → NPS-AUTH-FORBIDDEN", () => {
    expect(
      NIP_ERROR_TO_NPS_STATUS["NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR"],
    ).toBe("NPS-AUTH-FORBIDDEN");
  });

  it("NIP-TRUST-FRAME-NODES-PATTERN-INVALID → NPS-CLIENT-BAD-FRAME", () => {
    expect(
      NIP_ERROR_TO_NPS_STATUS["NIP-TRUST-FRAME-NODES-PATTERN-INVALID"],
    ).toBe("NPS-CLIENT-BAD-FRAME");
  });

  it("NIP-REVOKE-FRAME-INVALID → NPS-CLIENT-BAD-FRAME", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-REVOKE-FRAME-INVALID"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER → NPS-AUTH-FORBIDDEN", () => {
    expect(
      NIP_ERROR_TO_NPS_STATUS["NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER"],
    ).toBe("NPS-AUTH-FORBIDDEN");
  });

  it("NIP-REVOKE-FRAME-SERIAL-MISMATCH → NPS-CLIENT-BAD-PARAM", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-REVOKE-FRAME-SERIAL-MISMATCH"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
  });

  it("NIP-REVOKE-FRAME-REASON-UNKNOWN → NPS-CLIENT-BAD-FRAME", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-REVOKE-FRAME-REASON-UNKNOWN"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("NIP-CA-GROUP-REVOKED → NPS-AUTH-FORBIDDEN", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-GROUP-REVOKED"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NIP-CA-PARENT-NOT-FOUND → NPS-CLIENT-NOT-FOUND", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-PARENT-NOT-FOUND"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NIP-CA-PARENT-NOT-GROUP → NPS-CLIENT-BAD-PARAM", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-PARENT-NOT-GROUP"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
  });

  it("NIP-CA-SESSION-VALIDITY-INVALID → NPS-CLIENT-BAD-PARAM", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-SESSION-VALIDITY-INVALID"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
  });

  it("NIP-CA-JWS-INVALID → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-JWS-INVALID"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-CA-JWS-EXPIRED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CA-JWS-EXPIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-CERT-PARENT-REVOKED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CERT-PARENT-REVOKED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-OCSP-STAPLE-EXPIRED → NPS-AUTH-UNAUTHENTICATED (task spec)", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-OCSP-STAPLE-EXPIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NIP-REPUTATION-LOG-UNREACHABLE → NPS-DOWNSTREAM-UNAVAILABLE", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-REPUTATION-LOG-UNREACHABLE"]).toBe(
      "NPS-DOWNSTREAM-UNAVAILABLE",
    );
  });

  it("NIP-REPUTATION-GOSSIP-FORK → NPS-SERVER-INTERNAL", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-REPUTATION-GOSSIP-FORK"]).toBe(
      "NPS-SERVER-INTERNAL",
    );
  });

  it("covers all 38 spec codes + OCSP_STAPLE_EXPIRED", () => {
    const nipCodes = [
      "NIP-CERT-EXPIRED",
      "NIP-CERT-REVOKED",
      "NIP-CERT-SIGNATURE-INVALID",
      "NIP-CERT-UNTRUSTED-ISSUER",
      "NIP-CERT-CAPABILITY-MISSING",
      "NIP-CERT-SCOPE-VIOLATION",
      "NIP-CA-NID-NOT-FOUND",
      "NIP-CA-NID-ALREADY-EXISTS",
      "NIP-CA-SERIAL-DUPLICATE",
      "NIP-CA-RENEWAL-TOO-EARLY",
      "NIP-CA-SCOPE-EXPANSION-DENIED",
      "NIP-OCSP-UNAVAILABLE",
      "NIP-TRUST-FRAME-INVALID",
      "NIP-TRUST-FRAME-EXPIRED",
      "NIP-TRUST-FRAME-GRANTOR-REVOKED",
      "NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR",
      "NIP-TRUST-FRAME-NODES-PATTERN-INVALID",
      "NIP-REVOKE-FRAME-INVALID",
      "NIP-REVOKE-FRAME-UNAUTHORIZED-ISSUER",
      "NIP-REVOKE-FRAME-SERIAL-MISMATCH",
      "NIP-REVOKE-FRAME-REASON-UNKNOWN",
      "NIP-ASSURANCE-MISMATCH",
      "NIP-ASSURANCE-UNKNOWN",
      "NIP-REPUTATION-ENTRY-INVALID",
      "NIP-REPUTATION-LOG-UNREACHABLE",
      "NIP-REPUTATION-GOSSIP-FORK",
      "NIP-REPUTATION-GOSSIP-SIG-INVALID",
      "NIP-CERT-FORMAT-INVALID",
      "NIP-CERT-EKU-MISSING",
      "NIP-CERT-SUBJECT-NID-MISMATCH",
      "NIP-ACME-CHALLENGE-FAILED",
      "NIP-CA-GROUP-REVOKED",
      "NIP-CA-PARENT-NOT-FOUND",
      "NIP-CA-PARENT-NOT-GROUP",
      "NIP-CA-SESSION-VALIDITY-INVALID",
      "NIP-CA-JWS-INVALID",
      "NIP-CA-JWS-EXPIRED",
      "NIP-CERT-PARENT-REVOKED",
      "NIP-OCSP-STAPLE-EXPIRED",
    ];
    for (const c of nipCodes) {
      expect(NIP_ERROR_TO_NPS_STATUS).toHaveProperty(c);
    }
  });
});

// ── NDP ───────────────────────────────────────────────────────────────────────

describe("NDP error codes — completeness", () => {
  it("NDP_RESOLVE_NOT_FOUND wire value", () => {
    expect(NDP_RESOLVE_NOT_FOUND).toBe("NDP-RESOLVE-NOT-FOUND");
  });

  it("NDP_RESOLVE_AMBIGUOUS wire value", () => {
    expect(NDP_RESOLVE_AMBIGUOUS).toBe("NDP-RESOLVE-AMBIGUOUS");
  });

  it("NDP_RESOLVE_TIMEOUT wire value", () => {
    expect(NDP_RESOLVE_TIMEOUT).toBe("NDP-RESOLVE-TIMEOUT");
  });

  it("NDP_RESOLVE_STALE wire value", () => {
    expect(NDP_RESOLVE_STALE).toBe("NDP-RESOLVE-STALE");
  });

  it("NDP_ANNOUNCE_SIGNATURE_INVALID wire value", () => {
    expect(NDP_ANNOUNCE_SIGNATURE_INVALID).toBe(
      "NDP-ANNOUNCE-SIGNATURE-INVALID",
    );
  });

  it("NDP_ANNOUNCE_NID_MISMATCH wire value", () => {
    expect(NDP_ANNOUNCE_NID_MISMATCH).toBe("NDP-ANNOUNCE-NID-MISMATCH");
  });

  it("NDP_ANNOUNCE_ROLE_REMOVED wire value", () => {
    expect(NDP_ANNOUNCE_ROLE_REMOVED).toBe("NDP-ANNOUNCE-ROLE-REMOVED");
  });

  it("NDP_ANNOUNCE_ROLE_UNKNOWN wire value", () => {
    expect(NDP_ANNOUNCE_ROLE_UNKNOWN).toBe("NDP-ANNOUNCE-ROLE-UNKNOWN");
  });

  it("NDP_ANNOUNCE_CONFLICT wire value", () => {
    expect(NDP_ANNOUNCE_CONFLICT).toBe("NDP-ANNOUNCE-CONFLICT");
  });

  it("NDP_ANNOUNCE_PROFILE_VIOLATION wire value", () => {
    expect(NDP_ANNOUNCE_PROFILE_VIOLATION).toBe(
      "NDP-ANNOUNCE-PROFILE-VIOLATION",
    );
  });

  it("NDP_ANNOUNCE_STALE wire value", () => {
    expect(NDP_ANNOUNCE_STALE).toBe("NDP-ANNOUNCE-STALE");
  });

  it("NDP_GRAPH_SEQ_ROLLBACK wire value", () => {
    expect(NDP_GRAPH_SEQ_ROLLBACK).toBe("NDP-GRAPH-SEQ-ROLLBACK");
  });

  it("NDP_GRAPH_SEQ_GAP wire value", () => {
    expect(NDP_GRAPH_SEQ_GAP).toBe("NDP-GRAPH-SEQ-GAP");
  });

  it("NDP_ISSUER_NOT_ALLOWED wire value", () => {
    expect(NDP_ISSUER_NOT_ALLOWED).toBe("NDP-ISSUER-NOT-ALLOWED");
  });

  it("NDP_CA_ATTEST_REQUIRED wire value", () => {
    expect(NDP_CA_ATTEST_REQUIRED).toBe("NDP-CA-ATTEST-REQUIRED");
  });

  it("NDP_REGISTRY_UNAVAILABLE wire value", () => {
    expect(NDP_REGISTRY_UNAVAILABLE).toBe("NDP-REGISTRY-UNAVAILABLE");
  });

  it("NDP_GRAPH_INVALID wire value (task-specified)", () => {
    expect(NDP_GRAPH_INVALID).toBe("NDP-GRAPH-INVALID");
  });

  it("NDP_GRAPH_TOO_LARGE wire value (task-specified)", () => {
    expect(NDP_GRAPH_TOO_LARGE).toBe("NDP-GRAPH-TOO-LARGE");
  });

  it("NDP_FEDERATION_LOOP wire value (task-specified)", () => {
    expect(NDP_FEDERATION_LOOP).toBe("NDP-FEDERATION-LOOP");
  });
});

describe("NDP_ERROR_TO_NPS_STATUS mapping", () => {
  it("NDP-RESOLVE-NOT-FOUND → NPS-CLIENT-NOT-FOUND", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-RESOLVE-NOT-FOUND"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NDP-RESOLVE-AMBIGUOUS → NPS-CLIENT-CONFLICT", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-RESOLVE-AMBIGUOUS"]).toBe(
      "NPS-CLIENT-CONFLICT",
    );
  });

  it("NDP-RESOLVE-TIMEOUT → NPS-SERVER-TIMEOUT", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-RESOLVE-TIMEOUT"]).toBe(
      "NPS-SERVER-TIMEOUT",
    );
  });

  it("NDP-RESOLVE-STALE → NPS-CLIENT-NOT-FOUND", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-RESOLVE-STALE"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NDP-ANNOUNCE-SIGNATURE-INVALID → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-ANNOUNCE-SIGNATURE-INVALID"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NDP-ANNOUNCE-PROFILE-VIOLATION → NPS-AUTH-FORBIDDEN", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-ANNOUNCE-PROFILE-VIOLATION"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NDP-ANNOUNCE-STALE → NPS-CLIENT-NOT-FOUND", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-ANNOUNCE-STALE"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NDP-GRAPH-SEQ-GAP → NPS-STREAM-SEQ-GAP", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-GRAPH-SEQ-GAP"]).toBe(
      "NPS-STREAM-SEQ-GAP",
    );
  });

  it("NDP-ISSUER-NOT-ALLOWED → NPS-AUTH-FORBIDDEN", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-ISSUER-NOT-ALLOWED"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NDP-CA-ATTEST-REQUIRED → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-CA-ATTEST-REQUIRED"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NDP-REGISTRY-UNAVAILABLE → NPS-SERVER-UNAVAILABLE", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-REGISTRY-UNAVAILABLE"]).toBe(
      "NPS-SERVER-UNAVAILABLE",
    );
  });

  it("NDP-GRAPH-INVALID → NPS-CLIENT-BAD-FRAME (task spec)", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-GRAPH-INVALID"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("NDP-GRAPH-TOO-LARGE → NPS-LIMIT-PAYLOAD (task spec)", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-GRAPH-TOO-LARGE"]).toBe(
      "NPS-LIMIT-PAYLOAD",
    );
  });

  it("NDP-FEDERATION-LOOP → NPS-CLIENT-CONFLICT (task spec)", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-FEDERATION-LOOP"]).toBe(
      "NPS-CLIENT-CONFLICT",
    );
  });

  it("covers all spec NDP codes", () => {
    const specCodes = [
      "NDP-RESOLVE-NOT-FOUND",
      "NDP-RESOLVE-AMBIGUOUS",
      "NDP-RESOLVE-TIMEOUT",
      "NDP-RESOLVE-STALE",
      "NDP-ANNOUNCE-SIGNATURE-INVALID",
      "NDP-ANNOUNCE-NID-MISMATCH",
      "NDP-ANNOUNCE-ROLE-REMOVED",
      "NDP-ANNOUNCE-ROLE-UNKNOWN",
      "NDP-ANNOUNCE-CONFLICT",
      "NDP-ANNOUNCE-PROFILE-VIOLATION",
      "NDP-ANNOUNCE-STALE",
      "NDP-GRAPH-SEQ-ROLLBACK",
      "NDP-GRAPH-SEQ-GAP",
      "NDP-ISSUER-NOT-ALLOWED",
      "NDP-CA-ATTEST-REQUIRED",
      "NDP-REGISTRY-UNAVAILABLE",
    ];
    for (const c of specCodes) {
      expect(NDP_ERROR_TO_NPS_STATUS).toHaveProperty(c);
    }
  });
});

// ── NOP ───────────────────────────────────────────────────────────────────────

describe("NOP error codes — 20 spec codes + extras", () => {
  it("NOP_TASK_NOT_FOUND wire value", () => {
    expect(NOP_TASK_NOT_FOUND).toBe("NOP-TASK-NOT-FOUND");
  });

  it("NOP_TASK_TIMEOUT wire value", () => {
    expect(NOP_TASK_TIMEOUT).toBe("NOP-TASK-TIMEOUT");
  });

  it("NOP_TASK_DAG_INVALID wire value", () => {
    expect(NOP_TASK_DAG_INVALID).toBe("NOP-TASK-DAG-INVALID");
  });

  it("NOP_TASK_DAG_CYCLE wire value", () => {
    expect(NOP_TASK_DAG_CYCLE).toBe("NOP-TASK-DAG-CYCLE");
  });

  it("NOP_TASK_DAG_TOO_LARGE wire value", () => {
    expect(NOP_TASK_DAG_TOO_LARGE).toBe("NOP-TASK-DAG-TOO-LARGE");
  });

  it("NOP_TASK_ALREADY_COMPLETED wire value", () => {
    expect(NOP_TASK_ALREADY_COMPLETED).toBe("NOP-TASK-ALREADY-COMPLETED");
  });

  it("NOP_TASK_CANCELLED wire value", () => {
    expect(NOP_TASK_CANCELLED).toBe("NOP-TASK-CANCELLED");
  });

  it("NOP_DELEGATE_SCOPE_VIOLATION wire value", () => {
    expect(NOP_DELEGATE_SCOPE_VIOLATION).toBe("NOP-DELEGATE-SCOPE-VIOLATION");
  });

  it("NOP_DELEGATE_REJECTED wire value", () => {
    expect(NOP_DELEGATE_REJECTED).toBe("NOP-DELEGATE-REJECTED");
  });

  it("NOP_DELEGATE_CHAIN_TOO_DEEP wire value", () => {
    expect(NOP_DELEGATE_CHAIN_TOO_DEEP).toBe("NOP-DELEGATE-CHAIN-TOO-DEEP");
  });

  it("NOP_DELEGATE_TIMEOUT wire value", () => {
    expect(NOP_DELEGATE_TIMEOUT).toBe("NOP-DELEGATE-TIMEOUT");
  });

  it("NOP_SYNC_TIMEOUT wire value", () => {
    expect(NOP_SYNC_TIMEOUT).toBe("NOP-SYNC-TIMEOUT");
  });

  it("NOP_SYNC_DEPENDENCY_FAILED wire value", () => {
    expect(NOP_SYNC_DEPENDENCY_FAILED).toBe("NOP-SYNC-DEPENDENCY-FAILED");
  });

  it("NOP_STREAM_SEQ_GAP wire value", () => {
    expect(NOP_STREAM_SEQ_GAP).toBe("NOP-STREAM-SEQ-GAP");
  });

  it("NOP_STREAM_NID_MISMATCH wire value", () => {
    expect(NOP_STREAM_NID_MISMATCH).toBe("NOP-STREAM-NID-MISMATCH");
  });

  it("NOP_RESOURCE_INSUFFICIENT wire value", () => {
    expect(NOP_RESOURCE_INSUFFICIENT).toBe("NOP-RESOURCE-INSUFFICIENT");
  });

  it("NOP_CONDITION_EVAL_ERROR wire value", () => {
    expect(NOP_CONDITION_EVAL_ERROR).toBe("NOP-CONDITION-EVAL-ERROR");
  });

  it("NOP_INPUT_MAPPING_ERROR wire value", () => {
    expect(NOP_INPUT_MAPPING_ERROR).toBe("NOP-INPUT-MAPPING-ERROR");
  });

  it("NOP_COMPENSATION_FAILED wire value", () => {
    expect(NOP_COMPENSATION_FAILED).toBe("NOP-COMPENSATION-FAILED");
  });

  it("NOP_COMPENSATION_PARTIAL_FAILED wire value", () => {
    expect(NOP_COMPENSATION_PARTIAL_FAILED).toBe(
      "NOP-COMPENSATION-PARTIAL-FAILED",
    );
  });

  it("NOP_COMPENSATION_NOT_SUPPORTED wire value", () => {
    expect(NOP_COMPENSATION_NOT_SUPPORTED).toBe(
      "NOP-COMPENSATION-NOT-SUPPORTED",
    );
  });

  it("NOP_STREAM_NAK wire value (task-specified)", () => {
    expect(NOP_STREAM_NAK).toBe("NOP-STREAM-NAK");
  });

  it("NOP_CALLBACK_HMAC_MISSING wire value (task-specified)", () => {
    expect(NOP_CALLBACK_HMAC_MISSING).toBe("NOP-CALLBACK-HMAC-MISSING");
  });
});

describe("NOP_ERROR_TO_NPS_STATUS mapping", () => {
  it("NOP-TASK-NOT-FOUND → NPS-CLIENT-NOT-FOUND", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-TASK-NOT-FOUND"]).toBe(
      "NPS-CLIENT-NOT-FOUND",
    );
  });

  it("NOP-TASK-TIMEOUT → NPS-SERVER-TIMEOUT", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-TASK-TIMEOUT"]).toBe(
      "NPS-SERVER-TIMEOUT",
    );
  });

  it("NOP-TASK-DAG-INVALID → NPS-CLIENT-BAD-FRAME", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-TASK-DAG-INVALID"]).toBe(
      "NPS-CLIENT-BAD-FRAME",
    );
  });

  it("NOP-DELEGATE-SCOPE-VIOLATION → NPS-AUTH-FORBIDDEN", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-DELEGATE-SCOPE-VIOLATION"]).toBe(
      "NPS-AUTH-FORBIDDEN",
    );
  });

  it("NOP-DELEGATE-REJECTED → NPS-CLIENT-UNPROCESSABLE", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-DELEGATE-REJECTED"]).toBe(
      "NPS-CLIENT-UNPROCESSABLE",
    );
  });

  it("NOP-DELEGATE-CHAIN-TOO-DEEP → NPS-CLIENT-BAD-PARAM", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-DELEGATE-CHAIN-TOO-DEEP"]).toBe(
      "NPS-CLIENT-BAD-PARAM",
    );
  });

  it("NOP-STREAM-SEQ-GAP → NPS-STREAM-SEQ-GAP", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-STREAM-SEQ-GAP"]).toBe(
      "NPS-STREAM-SEQ-GAP",
    );
  });

  it("NOP-STREAM-NID-MISMATCH → NPS-AUTH-UNAUTHENTICATED", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-STREAM-NID-MISMATCH"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("NOP-RESOURCE-INSUFFICIENT → NPS-SERVER-UNAVAILABLE", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-RESOURCE-INSUFFICIENT"]).toBe(
      "NPS-SERVER-UNAVAILABLE",
    );
  });

  it("NOP-STREAM-NAK → NPS-STREAM-SEQ-GAP (task spec)", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-STREAM-NAK"]).toBe(
      "NPS-STREAM-SEQ-GAP",
    );
  });

  it("NOP-CALLBACK-HMAC-MISSING → NPS-AUTH-UNAUTHENTICATED (task spec)", () => {
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-CALLBACK-HMAC-MISSING"]).toBe(
      "NPS-AUTH-UNAUTHENTICATED",
    );
  });

  it("covers the complete NOP error surface", () => {
    const allCodes = [
      "NOP-TASK-NOT-FOUND",
      "NOP-TASK-TIMEOUT",
      "NOP-TASK-DAG-INVALID",
      "NOP-TASK-DAG-CYCLE",
      "NOP-TASK-DAG-TOO-LARGE",
      "NOP-TASK-ALREADY-COMPLETED",
      "NOP-TASK-CANCELLED",
      "NOP-DELEGATE-SCOPE-VIOLATION",
      "NOP-DELEGATE-REJECTED",
      "NOP-DELEGATE-CHAIN-TOO-DEEP",
      "NOP-DELEGATE-TIMEOUT",
      "NOP-SYNC-TIMEOUT",
      "NOP-SYNC-DEPENDENCY-FAILED",
      "NOP-STREAM-SEQ-GAP",
      "NOP-STREAM-NID-MISMATCH",
      "NOP-RESOURCE-INSUFFICIENT",
      "NOP-CONDITION-EVAL-ERROR",
      "NOP-INPUT-MAPPING-ERROR",
      "NOP-COMPENSATION-FAILED",
      "NOP-COMPENSATION-PARTIAL-FAILED",
      "NOP-COMPENSATION-NOT-SUPPORTED",
      "NOP-STREAM-NAK",
      "NOP-CALLBACK-HMAC-MISSING",
      "NOP-CALLBACK-INVALID",
      "NOP-CALLBACK-HMAC-INVALID",
      "NOP-CLAIM-CONFLICT",
      "NOP-SPAWN-SPEC-INVALID",
      "NOP-RUNTIME-IDLE-TIMEOUT",
      "NOP-RUNTIME-MAX-RUNTIME",
      "NOP-TASK-RESULT-EXPIRED",
      "NOP-STREAM-NAK-UNRESOLVABLE",
    ];
    for (const c of allCodes) {
      expect(NOP_ERROR_TO_NPS_STATUS).toHaveProperty(c);
    }
  });
});

// ── alpha.17 additions (NPS-CR-0009, NIP v0.12, NPS-CR-0010) ─────────────────

describe("alpha.17 error codes", () => {
  it("NPS-CR-0009 registers exactly three new codes with their spec statuses", () => {
    expect(NDP_ERROR_TO_NPS_STATUS["NDP-CLUSTER-SPLIT"]).toBe("NPS-CLIENT-CONFLICT");
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-ANCHOR-NOT-LEADER"]).toBe("NPS-CLIENT-CONFLICT");
    expect(NWP_ERROR_TO_NPS_STATUS["NWP-ANCHOR-EPOCH-FENCED"]).toBe("NPS-CLIENT-CONFLICT");
    // all three are 409
    for (const code of ["NDP-CLUSTER-SPLIT", "NWP-ANCHOR-NOT-LEADER", "NWP-ANCHOR-EPOCH-FENCED"]) {
      const status = (NDP_ERROR_TO_NPS_STATUS[code] ?? NWP_ERROR_TO_NPS_STATUS[code]) as NpsStatusCode;
      expect(toHttpStatus(status)).toBe(409);
    }
  });

  it("NPS-CR-0009 reuses NCP-NID-MISMATCH and NOP-CLAIM-CONFLICT without redefining them", () => {
    expect(NCP_ERROR_TO_NPS_STATUS["NCP-NID-MISMATCH"]).toBe("NPS-AUTH-UNAUTHENTICATED");
    expect(NOP_ERROR_TO_NPS_STATUS["NOP-CLAIM-CONFLICT"]).toBe("NPS-CLIENT-CONFLICT");
  });

  it("NIP v0.12 adds exactly one code, mapped to NPS-AUTH-FORBIDDEN", () => {
    expect(NIP_ERROR_TO_NPS_STATUS["NIP-CERT-CAPABILITIES-EXCEEDED"]).toBe("NPS-AUTH-FORBIDDEN");
    expect(toHttpStatus("NPS-AUTH-FORBIDDEN")).toBe(403);
  });

  it("NPS-CR-0010 registers the Bridge codes in both directions", () => {
    const rows: Record<string, string> = {
      "NWP-BRIDGE-DIRECTION-UNSUPPORTED": "NPS-SERVER-UNSUPPORTED",
      "NWP-BRIDGE-TARGET-INVALID":        "NPS-CLIENT-UNPROCESSABLE",
      "NWP-BRIDGE-PROTOCOL-UNSUPPORTED":  "NPS-SERVER-UNSUPPORTED",
      "NWP-BRIDGE-ENDPOINT-INVALID":      "NPS-CLIENT-UNPROCESSABLE",
      "NWP-BRIDGE-UPSTREAM-FAILED":       "NPS-DOWNSTREAM-UNAVAILABLE",
      "NWP-BRIDGE-SERVER-TOOL-NOT-FOUND": "NPS-CLIENT-NOT-FOUND",
      "NWP-BRIDGE-SERVER-DISPATCHER-MISSING": "NPS-SERVER-INTERNAL",
      "NWP-BRIDGE-SERVER-DISPATCH-FAILED": "NPS-SERVER-INTERNAL",
    };
    for (const [code, status] of Object.entries(rows)) {
      expect(NWP_ERROR_TO_NPS_STATUS[code], code).toBe(status);
    }
  });

  it("does not reintroduce the invented statuses NPS-CR-0010 removed", () => {
    const removed = ["NPS-SERVER-NOT-IMPLEMENTED", "NPS-SERVER-ERROR",
      "NPS-CLIENT-UNAUTHORIZED", "NPS-CLIENT-BAD-REQUEST", "NPS-SERVER-UPSTREAM-FAILED"];
    const declared = new Set<string>(Object.values(NpsStatusCodes));
    const mapped = new Set<string>([
      ...Object.values(NCP_ERROR_TO_NPS_STATUS), ...Object.values(NWP_ERROR_TO_NPS_STATUS),
      ...Object.values(NIP_ERROR_TO_NPS_STATUS), ...Object.values(NDP_ERROR_TO_NPS_STATUS),
      ...Object.values(NOP_ERROR_TO_NPS_STATUS),
    ]);
    for (const s of removed) {
      expect(declared.has(s), s).toBe(false);
      expect(mapped.has(s), s).toBe(false);
    }
  });
});
