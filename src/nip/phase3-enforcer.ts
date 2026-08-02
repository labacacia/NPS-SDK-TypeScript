// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NIP v0.12 §7.5 — **Phase-3 enforcement**: turns the Phase-1–2 advisory CA-attestation
 * checks into hard failures.
 *
 * Applies only to `v2-x509` frames; each attribute check applies only when the corresponding
 * certificate extension is present, so self-declared NIDs and certs without attestation
 * extensions are unaffected. The role/capability checks are **subset** checks — the frame
 * MUST NOT claim more than the CA attested.
 *
 * Stateless and pure: no I/O, no network. The clock is injectable so tests are deterministic.
 */

import type { X509Certificate } from "@peculiar/x509";

import * as ec from "./error-codes.js";
import type { IdentFrame } from "./frames.js";
import type { NipIdentVerifyResult } from "./verifier.js";
import {
  DerError,
  DerReader,
  TAG_CONTEXT_0,
  TAG_ENUMERATED,
  TAG_GENERALIZED_TIME,
  TAG_OBJECT_ID,
  TAG_OCTET_STRING,
  TAG_SEQUENCE,
  isContextSpecific,
} from "./x509/der.js";
import { ID_NPS_CAPABILITIES, ID_NPS_NODE_ROLES } from "./x509/oids.js";

function ok(): NipIdentVerifyResult { return { valid: true, stepFailed: 0 }; }

/** Phase-3 failures always report step 3 — they run inside the verifier's step 3. */
function fail(errorCode: string, message: string): NipIdentVerifyResult {
  return { valid: false, stepFailed: 3, errorCode, message };
}

/**
 * Run the Phase-3 checks against the leaf certificate. Evaluation order is fixed:
 * **node_roles → capabilities → OCSP staple**.
 *
 * The fourth §7.5 row — assurance — lives in `nip/x509/verifier.ts`
 * (`checkAssuranceLevel`), where it runs unconditionally as part of chain validation
 * regardless of this flag. That placement mirrors the reference implementation.
 */
export function enforcePhase3(
  frame: IdentFrame,
  leaf: X509Certificate,
  now?: Date,
): NipIdentVerifyResult {
  if (frame === undefined || frame === null) throw new TypeError("frame is required");
  if (leaf === undefined || leaf === null) throw new TypeError("leaf is required");
  const when = now ?? new Date();

  // 1. node_roles ⊆ id-nps-node-roles (only when the extension is present)
  const attestedRoles = readUtf8SequenceExtension(leaf, ID_NPS_NODE_ROLES);
  if (attestedRoles !== null) {
    const excess = difference(frame.nodeRoles ?? [], attestedRoles);
    if (excess.length > 0) {
      return fail(ec.CERT_NODE_ROLES_MISMATCH,
        `IdentFrame.node_roles claims role(s) not attested by id-nps-node-roles: ${excess.join(", ")}.`);
    }
  }

  // 2. capabilities ⊆ id-nps-capabilities (only when the extension is present)
  const attestedCaps = readUtf8SequenceExtension(leaf, ID_NPS_CAPABILITIES);
  if (attestedCaps !== null) {
    const excess = difference(frameCapabilities(frame), attestedCaps);
    if (excess.length > 0) {
      return fail(ec.CERT_CAPABILITIES_EXCEEDED,
        `IdentFrame.capabilities claims capabilit(ies) not attested by id-nps-capabilities: ${excess.join(", ")}.`);
    }
  }

  // 3. OCSP staple MUST be present and unexpired — the one check with no "only if present"
  //    escape. All four failure shapes collapse onto NIP-OCSP-STAPLE-EXPIRED: fail closed.
  const staple = frame.ocsp_staple;
  if (staple === null || staple === undefined || staple === "") {
    return fail(ec.OCSP_STAPLE_EXPIRED,
      "Phase-3 enforcement requires ocsp_staple on v2-x509 IdentFrames; none was supplied.");
  }
  let stapleDer: Uint8Array;
  try {
    stapleDer = fromBase64Url(staple);
  } catch {
    return fail(ec.OCSP_STAPLE_EXPIRED, "ocsp_staple is not valid base64url.");
  }
  const nextUpdate = tryGetOcspNextUpdate(stapleDer);
  if (nextUpdate === null) {
    return fail(ec.OCSP_STAPLE_EXPIRED,
      "ocsp_staple could not be parsed as a DER OCSPResponse with a nextUpdate.");
  }
  // `<=`, not `<`: a staple whose nextUpdate is exactly now has elapsed.
  if (nextUpdate.getTime() <= when.getTime()) {
    return fail(ec.OCSP_STAPLE_EXPIRED,
      `ocsp_staple nextUpdate ${nextUpdate.toISOString()} has elapsed.`);
  }

  return ok();
}

/**
 * Read a `SEQUENCE OF UTF8String` extension (`id-nps-node-roles` / `id-nps-capabilities`).
 *
 * The tri-state return **is** the rule, so the three states must stay distinguishable:
 *
 * | Extension state           | Return | Behaviour                                        |
 * |---------------------------|--------|--------------------------------------------------|
 * | absent from the cert      | `null` | check skipped entirely — the frame may claim anything |
 * | present, valid            | list (possibly `[]`) | subset check runs against that list |
 * | present, malformed ASN.1  | `[]`   | strictest reading — any claim then exceeds it and fails |
 */
export function readUtf8SequenceExtension(
  cert: X509Certificate,
  oid: string,
): string[] | null {
  const ext = cert.extensions.find((e) => e.type === oid);
  if (!ext) return null;
  try {
    const seq = new DerReader(new Uint8Array(ext.value)).readSequence(TAG_SEQUENCE);
    const values: string[] = [];
    while (seq.hasData) values.push(seq.readUtf8String());
    return values;
  } catch {
    return [];
  }
}

/**
 * Minimal RFC 6960 DER walk: `OCSPResponse` → `BasicOCSPResponse` → the **first**
 * `SingleResponse.nextUpdate`. Returns `null` when `responseBytes` is absent, `responses`
 * is empty, `nextUpdate` is absent, or any ASN.1 content is malformed.
 *
 * Signature verification of the staple is the full OCSP pipeline's job; the Phase-3 gate
 * needs only freshness.
 *
 * ```
 * OCSPResponse      ::= SEQUENCE { responseStatus ENUMERATED,
 *                                  responseBytes [0] EXPLICIT ResponseBytes OPTIONAL }
 * ResponseBytes     ::= SEQUENCE { responseType OID, response OCTET STRING }
 * BasicOCSPResponse ::= SEQUENCE { tbsResponseData ResponseData, ... }
 * ResponseData      ::= SEQUENCE { version [0] EXPLICIT OPTIONAL, responderID CHOICE [1]/[2],
 *                                  producedAt GeneralizedTime, responses SEQUENCE OF SingleResponse }
 * SingleResponse    ::= SEQUENCE { certID SEQUENCE, certStatus CHOICE, thisUpdate GeneralizedTime,
 *                                  nextUpdate [0] EXPLICIT GeneralizedTime OPTIONAL, ... }
 * ```
 */
export function tryGetOcspNextUpdate(der: Uint8Array): Date | null {
  try {
    const root = new DerReader(der).readSequence(TAG_SEQUENCE);
    root.read(TAG_ENUMERATED);                       // responseStatus
    if (!root.hasData) return null;                  // responseBytes absent
    const respBytesWrap = root.readSequence(TAG_CONTEXT_0);
    const respBytes = respBytesWrap.readSequence(TAG_SEQUENCE);
    respBytes.read(TAG_OBJECT_ID);                   // id-pkix-ocsp-basic
    const basicDer = respBytes.readContent(TAG_OCTET_STRING);

    const basic = new DerReader(basicDer).readSequence(TAG_SEQUENCE);
    const tbs = basic.readSequence(TAG_SEQUENCE);    // ResponseData

    if (tbs.hasData && tbs.peekTag() === TAG_CONTEXT_0) tbs.skip();          // version [0]
    if (tbs.hasData && isContextSpecific(tbs.peekTag())) tbs.skip();         // responderID [1]/[2]
    tbs.read(TAG_GENERALIZED_TIME);                                          // producedAt

    const responses = tbs.readSequence(TAG_SEQUENCE);
    if (!responses.hasData) return null;             // no SingleResponse
    const single = responses.readSequence(TAG_SEQUENCE);

    single.read(TAG_SEQUENCE);                       // certID
    single.skip();                                   // certStatus (context-specific CHOICE)
    single.read(TAG_GENERALIZED_TIME);               // thisUpdate

    if (!single.hasData || single.peekTag() !== TAG_CONTEXT_0) return null;  // nextUpdate absent
    return single.readSequence(TAG_CONTEXT_0).readGeneralizedTime();
  } catch (e) {
    if (e instanceof DerError || e instanceof RangeError || e instanceof TypeError) return null;
    throw e;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * `claimed \ attested`, with **ordinal / exact-byte** comparison — no case folding, no
 * normalisation, no trimming. Duplicates are irrelevant (it is a set difference).
 */
function difference(claimed: readonly string[], attested: readonly string[]): string[] {
  const set = new Set(attested);
  const out: string[] = [];
  for (const c of claimed) {
    if (!set.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * The capability set an IdentFrame claims. This SDK carries capabilities inside
 * `metadata` (the normative wire location for a NIP IdentFrame), whereas the .NET
 * reference exposes them as a top-level member; both denote the same claim.
 */
function frameCapabilities(frame: IdentFrame): readonly string[] {
  return frame.metadata?.capabilities ?? [];
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error("not base64url");
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}
