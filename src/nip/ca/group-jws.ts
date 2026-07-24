// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Group-JWS verifier for NPS-CR-0003 §3.5 / §5.1.3 session-issue requests.
 * Mirrors .NET `NPS.NIP.Crypto.NipGroupJws`.
 *
 * The flattened JWS shape is:
 * ```
 * { "protected": "<b64url(header)>", "payload": "<b64url(payload)>", "signature": "<b64url(Ed25519 sig)>" }
 * ```
 * where the protected header MUST be
 * `{ "alg": "EdDSA", "kid": "<group_nid>", "nps-purpose": "session-issue" }`
 * and the signature is computed over the ASCII bytes of
 * `protected || "." || payload` per RFC 7515 §3.
 */

import { verify as edVerify, type KeyObject } from "node:crypto";

import { CA_JWS_INVALID } from "../error-codes.js";
import { fromBase64Url } from "./signer.js";

export const EXPECTED_ALG = "EdDSA" as const;
export const EXPECTED_PURPOSE = "session-issue" as const;

/** Flattened JWS object as it appears on the wire / in JSON. */
export interface FlattenedJws {
  protected?: string;
  payload?: string;
  signature?: string;
}

export interface GroupJwsVerifyResult {
  ok: boolean;
  payloadJson?: string;
  kid?: string;
  errorCode?: string;
}

/**
 * Parses + verifies a flattened JWS object. On success returns the decoded
 * payload as JSON text and the asserted `kid`; on failure returns the matching
 * error code (`NIP-CA-JWS-INVALID`).
 */
export function tryVerify(jws: FlattenedJws, groupPubKey: KeyObject): GroupJwsVerifyResult {
  if (!jws.protected || !jws.payload || !jws.signature) {
    return { ok: false, errorCode: CA_JWS_INVALID };
  }

  let headerBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    headerBytes = fromBase64Url(jws.protected);
    payloadBytes = fromBase64Url(jws.payload);
    sigBytes = fromBase64Url(jws.signature);
  } catch {
    return { ok: false, errorCode: CA_JWS_INVALID };
  }

  let header: { alg?: string; kid?: string; "nps-purpose"?: string };
  try {
    header = JSON.parse(Buffer.from(headerBytes).toString("utf8"));
  } catch {
    return { ok: false, errorCode: CA_JWS_INVALID };
  }
  if (
    header.alg !== EXPECTED_ALG ||
    header["nps-purpose"] !== EXPECTED_PURPOSE ||
    !header.kid
  ) {
    return { ok: false, errorCode: CA_JWS_INVALID };
  }

  // RFC 7515 §3 signing input: ASCII(protected) "." ASCII(payload).
  const signingInput = Buffer.from(`${jws.protected}.${jws.payload}`, "ascii");
  let valid: boolean;
  try {
    valid = edVerify(null, signingInput, groupPubKey, Buffer.from(sigBytes));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, errorCode: CA_JWS_INVALID };

  return {
    ok: true,
    kid: header.kid,
    payloadJson: Buffer.from(payloadBytes).toString("utf8"),
  };
}
