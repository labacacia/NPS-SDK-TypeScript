// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * TrustFrameValidator — open TrustFrame validator for self-hosted deployments
 * that pin trusted grantor anchors explicitly. Parity with the .NET reference
 * `NPS.NIP.Verification.TrustFrameValidator`.
 *
 * It checks frame shape, timestamps, grantor/grantee membership, required
 * capability scope, and target node scope. It does NOT verify the TrustFrame
 * signature (that is the caller's responsibility, matching the .NET reference).
 */

import * as ec from "./error-codes.js";
import type { TrustFrame } from "./frames.js";
import { NipIdentVerifier, type NipIdentVerifyResult } from "./verifier.js";

/** Inputs for {@link validateTrustFrame} — parity with .NET TrustFrameValidationContext. */
export interface TrustFrameValidationContext {
  /** Grantor CA NIDs that this node trusts as anchors. */
  trustedGrantors:       ReadonlySet<string> | readonly string[];
  /** The CA NID expected to be authorized by the TrustFrame. */
  expectedGranteeCa:     string;
  /** Capabilities required for the current request. */
  requiredCapabilities?: readonly string[];
  /** Target NWP path required for the current request. */
  targetNodePath?:       string;
  /** Clock override for tests. */
  asOf?:                 Date;
}

function fail(step: number, errorCode: string, message: string): NipIdentVerifyResult {
  return { valid: false, stepFailed: step, errorCode, message };
}

function ok(): NipIdentVerifyResult {
  return { valid: true, stepFailed: 0 };
}

function isBlank(s: string | null | undefined): boolean {
  return s === null || s === undefined || s.trim().length === 0;
}

function grantorTrusted(
  grantors: ReadonlySet<string> | readonly string[], grantor: string,
): boolean {
  return grantors instanceof Set
    ? grantors.has(grantor)
    : (grantors as readonly string[]).includes(grantor);
}

/**
 * Validates a {@link TrustFrame} against the given context. Returns a
 * {@link NipIdentVerifyResult}; `valid: true` when all checks pass.
 */
export function validateTrustFrame(
  frame: TrustFrame,
  context: TrustFrameValidationContext,
): NipIdentVerifyResult {
  // Shape check.
  if (isBlank(frame.grantorNid)
    || isBlank(frame.granteeCa)
    || isBlank(frame.issuedAt)
    || isBlank(frame.expiresAt)
    || isBlank(frame.serial)
    || isBlank(frame.signerNid)
    || isBlank(frame.signature)
    || frame.trustScope.length === 0
    || frame.nodes.length === 0) {
    return fail(3, ec.TRUST_FRAME_INVALID,
      "TrustFrame is missing grantor, grantee, issued_at, expires_at, serial, signer_nid, signature, trust_scope, or nodes.");
  }

  // Timestamp validity.
  if (Number.isNaN(Date.parse(frame.issuedAt))) {
    return fail(3, ec.TRUST_FRAME_INVALID,
      `TrustFrame issued_at is not a valid timestamp: ${frame.issuedAt}.`);
  }
  const expiresAt = Date.parse(frame.expiresAt);
  if (Number.isNaN(expiresAt)) {
    return fail(3, ec.TRUST_FRAME_INVALID,
      `TrustFrame expires_at is not a valid timestamp: ${frame.expiresAt}.`);
  }

  // Expiry.
  const now = context.asOf ?? new Date();
  if (expiresAt <= now.getTime()) {
    return fail(3, ec.TRUST_FRAME_EXPIRED, `TrustFrame expired at ${frame.expiresAt}.`);
  }

  // Trusted grantor.
  if (!grantorTrusted(context.trustedGrantors, frame.grantorNid)) {
    return fail(3, ec.CERT_UNTRUSTED_ISSUER,
      `TrustFrame grantor '${frame.grantorNid}' is not a trusted grantor.`);
  }

  // Grantee CA match.
  if (frame.granteeCa !== context.expectedGranteeCa) {
    return fail(3, ec.TRUST_FRAME_INVALID,
      `TrustFrame grantee '${frame.granteeCa}' does not match expected CA '${context.expectedGranteeCa}'.`);
  }

  // Required capabilities ⊆ trust_scope.
  if (context.requiredCapabilities && context.requiredCapabilities.length > 0) {
    const granted = new Set(frame.trustScope);
    const missing = context.requiredCapabilities.filter((c) => !granted.has(c));
    if (missing.length > 0) {
      return fail(5, ec.TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR,
        `TrustFrame is missing required capabilities: ${missing.join(", ")}.`);
    }
  }

  // Target node path covered by frame.nodes.
  if (context.targetNodePath !== undefined) {
    const covered = frame.nodes.some(
      (pattern) => NipIdentVerifier.nwpPathMatches(pattern, context.targetNodePath!),
    );
    if (!covered) {
      return fail(6, ec.CERT_SCOPE_VIOLATION,
        `Target path '${context.targetNodePath}' is not covered by the TrustFrame node scope.`);
    }
  }

  return ok();
}
