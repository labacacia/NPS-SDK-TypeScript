// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NipIdentVerifier — Node-side IdentFrame verifier.
 *
 * Two entry points are provided:
 *
 *  - {@link NipIdentVerifier.verify} — the Phase-1 dual-trust check
 *    (NPS-RFC-0002 §8.1): v1 Ed25519 signature, optional minimum assurance
 *    level, and X.509 chain validation for `v2-x509` frames. Kept for
 *    backward compatibility.
 *
 *  - {@link NipIdentVerifier.verifyIdent} — the full NPS-3 §7 six-step flow,
 *    mirroring the .NET reference `NipIdentVerifier.VerifyAsync`. All six
 *    steps MUST pass:
 *      1. Expiry:        `expires_at > now` (context.asOf or now)
 *      2. Trusted issuer: `issued_by` is in the trusted-issuer map
 *      3. Signature:      Ed25519 vs issuer pubkey, PLUS X.509 chain when
 *                         `cert_format === "v2-x509"` && trustedX509Roots set
 *      4. Revocation:     local CRL → revocationCheck → revocationStore →
 *                         OCSP GET {ocspUrl}/{nid}; OCSP failure honours
 *                         ocspFailOpen; pass-through when unconfigured
 *      5. Capabilities:   frame caps ⊇ context.requiredCapabilities
 *      6. Scope:          context.targetNodePath matched by scope node patterns
 */

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import type { X509Certificate } from "@peculiar/x509";

import { AssuranceLevel } from "./assurance-level.js";
import * as cf from "./cert-format.js";
import * as ec from "./error-codes.js";
import type { IdentFrame } from "./frames.js";
import { verify as verifyX509 } from "./x509/verifier.js";

// noble/ed25519 needs sha512 wired up.
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

// ── Revocation plumbing (mirror of .NET NipRevocationCheck / INipCaStore) ─────

/**
 * Live revocation callback. Return a failing {@link NipIdentVerifyResult} to
 * reject the identity, or `null` / a passing result to continue to the next
 * configured revocation source. Mirrors .NET `NipRevocationCheck`.
 */
export type NipRevocationCheck = (
  frame: IdentFrame,
  signal?: AbortSignal,
) => Promise<NipIdentVerifyResult | null> | NipIdentVerifyResult | null;

/**
 * Minimal revocation record, matching the fields the verifier reads from the
 * .NET `NipCertRecord`. A populated `revokedAt` marks the serial as revoked.
 */
export interface NipCertRecord {
  serial:        string;
  revokedAt?:    string | null;
  revokeReason?: string | null;
}

/**
 * Live revocation store used as a revocation source (Step 4). Mirrors the
 * subset of .NET `INipCaStore` the verifier depends on.
 */
export interface NipRevocationStore {
  getBySerial(serial: string, signal?: AbortSignal): Promise<NipCertRecord | null> | NipCertRecord | null;
}

// ── Options (superset of the dual-trust options; adds six-step config) ─────────

export interface NipVerifierOptions {
  /**
   * Map of issuer NID → CA public key string (`ed25519:<hex>` or
   * `ed25519:<base64>`). Used by both the dual-trust `verify` and the
   * six-step `verifyIdent` (Step 2 trusted-issuer + Step 3 signature).
   * `trustedCaPublicKeys` is the canonical name; `trustedIssuers` is accepted
   * as an alias matching the .NET `NipVerifierOptions.TrustedIssuers`.
   */
  trustedCaPublicKeys?: Readonly<Record<string, string>>;
  /** Alias for {@link trustedCaPublicKeys} matching .NET `TrustedIssuers`. */
  trustedIssuers?:      Readonly<Record<string, string>>;
  /** X.509 trust anchors. Empty/undefined makes the X.509 step reject v2 frames. */
  trustedX509Roots?:    readonly X509Certificate[];
  /** Minimum required assurance level (NPS-RFC-0003) — dual-trust `verify` only. */
  minAssuranceLevel?:   AssuranceLevel;

  /** Local set of revoked serials, checked before any network call (Step 4). */
  localRevokedSerials?: ReadonlySet<string> | readonly string[];
  /** Live revocation callback, run after the local CRL (Step 4). */
  revocationCheck?:     NipRevocationCheck;
  /** Live revocation store, queried by serial after the callback (Step 4). */
  revocationStore?:     NipRevocationStore;
  /** OCSP endpoint base URL. GET `{ocspUrl}/{nid}` → `{valid,error_code}` (Step 4). */
  ocspUrl?:             string;
  /** When true, OCSP transport failures pass through. Default is fail-closed. */
  ocspFailOpen?:        boolean;
  /**
   * Optional fetch override (for tests). Defaults to the global `fetch`.
   * Follows the web-standard fetch signature.
   */
  fetch?:               typeof fetch;
}

// ── Result + context (parity with .NET NipIdentVerifyResult / NipVerifyContext)

export interface NipIdentVerifyResult {
  valid:       boolean;
  /** Failed step number (1–6), or 0 on success. */
  stepFailed:  number;
  errorCode?:  string;
  message?:    string;
}

/**
 * Per-request context for the six-step flow (Steps 1, 5, 6).
 * Mirrors .NET `NipVerifyContext`. All fields optional — omit to skip the
 * corresponding check.
 */
export interface NipVerifyContext {
  /** Capabilities the Node requires the Agent to hold (Step 5). */
  requiredCapabilities?: readonly string[];
  /** Full NWP node path the Agent is trying to access (Step 6). */
  targetNodePath?:       string;
  /** Clock override (replaces `Date.now()` in the expiry check). */
  asOf?:                 Date;
  /** Minimum required assurance level (NPS-RFC-0003; carried through). */
  minAssuranceLevel?:    AssuranceLevel;
}

function ok(): NipIdentVerifyResult { return { valid: true, stepFailed: 0 }; }

function fail(stepFailed: number, errorCode: string, message: string): NipIdentVerifyResult {
  return { valid: false, stepFailed, errorCode, message };
}

export class NipIdentVerifier {
  constructor(public readonly options: NipVerifierOptions) {}

  private get issuerKeys(): Readonly<Record<string, string>> {
    return this.options.trustedCaPublicKeys ?? this.options.trustedIssuers ?? {};
  }

  // ── Dual-trust verifier (NPS-RFC-0002 §8.1) — unchanged behaviour ──────────

  async verify(frame: IdentFrame, issuerNid: string): Promise<NipIdentVerifyResult> {
    // Step 1: v1 Ed25519 signature check ────────────────────────────────
    const caPubKeyStr = this.issuerKeys[issuerNid];
    if (caPubKeyStr === undefined) {
      return fail(1, ec.CERT_UNTRUSTED_ISSUER,
        `no trusted CA public key for issuer: ${issuerNid}`);
    }
    const sigResult = this.checkSignature(frame, caPubKeyStr, 1);
    if (!sigResult.valid) return sigResult;

    // Step 2: minimum assurance level ───────────────────────────────────
    const minLevel = this.options.minAssuranceLevel;
    if (minLevel !== undefined) {
      const got = frame.assuranceLevel ?? AssuranceLevel.ANONYMOUS;
      if (!got.meetsOrExceeds(minLevel)) {
        return fail(2, ec.ASSURANCE_MISMATCH,
          `assurance_level (${got.wire}) below required minimum (${minLevel.wire})`);
      }
    }

    // Step 3b: X.509 chain check (only if both opt-ins present) ──────────
    const x509Result = await this.checkX509(frame, 3);
    if (!x509Result.valid) return x509Result;

    return ok();
  }

  // ── Full six-step flow (NPS-3 §7) — parity with .NET VerifyAsync ───────────

  async verifyIdent(
    frame: IdentFrame,
    context: NipVerifyContext = {},
    signal?: AbortSignal,
  ): Promise<NipIdentVerifyResult> {
    const now = context.asOf ?? new Date();

    // Step 1: Expiry ──────────────────────────────────────────────────────
    const expiresAtStr = frame.metadata.expiresAt;
    const expiresAt = expiresAtStr ? Date.parse(expiresAtStr) : NaN;
    if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
      return fail(1, ec.CERT_EXPIRED,
        `Certificate expired at ${expiresAtStr ?? "<missing>"}.`);
    }

    // Step 2: Trusted issuer ──────────────────────────────────────────────
    const issuedBy = frame.metadata.issuer;
    const issuerPubKeyEncoded = this.issuerKeys[issuedBy];
    if (issuerPubKeyEncoded === undefined) {
      return fail(2, ec.CERT_UNTRUSTED_ISSUER,
        `Issuer '${issuedBy}' is not in the trusted issuers list.`);
    }

    // Step 3: Signature (Ed25519) + X.509 chain (v2 only) ─────────────────
    const sigResult = this.checkSignature(frame, issuerPubKeyEncoded, 3);
    if (!sigResult.valid) return sigResult;
    const x509Result = await this.checkX509(frame, 3);
    if (!x509Result.valid) return x509Result;

    // Step 4: Revocation ──────────────────────────────────────────────────
    const revResult = await this.checkRevocation(frame, signal);
    if (!revResult.valid) return revResult;

    // Step 5: Capabilities ────────────────────────────────────────────────
    const required = context.requiredCapabilities;
    if (required && required.length > 0) {
      const have = new Set(frame.metadata.capabilities ?? []);
      const missing = required.filter((c) => !have.has(c));
      if (missing.length > 0) {
        return fail(5, ec.CERT_CAPABILITY_MISSING,
          `Certificate is missing required capabilities: ${missing.join(", ")}.`);
      }
    }

    // Step 6: Scope ───────────────────────────────────────────────────────
    if (context.targetNodePath !== undefined) {
      const scopeResult = NipIdentVerifier.checkScope(frame, context.targetNodePath);
      if (!scopeResult.valid) return scopeResult;
    }

    return ok();
  }

  // ── Shared step helpers ────────────────────────────────────────────────────

  private checkSignature(
    frame: IdentFrame, caPubKeyStr: string, step: number,
  ): NipIdentVerifyResult {
    if (!frame.signature?.startsWith("ed25519:")) {
      return fail(step, ec.CERT_SIGNATURE_INVALID, "missing or malformed signature");
    }
    try {
      const caPubBytes = parsePubKeyString(caPubKeyStr);
      const sigBytes   = decodeSignature(frame.signature.slice("ed25519:".length));
      const canonical  = canonicalJson(frame.unsignedDict());
      const msg        = new TextEncoder().encode(canonical);
      if (!ed25519.verify(sigBytes, msg, caPubBytes)) {
        return fail(step, ec.CERT_SIGNATURE_INVALID,
          "v1 Ed25519 signature did not verify against issuer CA key");
      }
    } catch (e) {
      return fail(step, ec.CERT_SIGNATURE_INVALID,
        `v1 signature verification error: ${(e as Error).message}`);
    }
    return ok();
  }

  private async checkX509(frame: IdentFrame, step: number): Promise<NipIdentVerifyResult> {
    const trustedRoots = this.options.trustedX509Roots ?? [];
    const hasV2Trust = trustedRoots.length > 0;
    const isV2Frame  = frame.certFormat === cf.V2_X509;
    if (hasV2Trust && isV2Frame) {
      const x509Result = await verifyX509({
        certChainBase64UrlDer:  frame.certChain ?? [],
        assertedNid:            frame.nid,
        assertedAssuranceLevel: frame.assuranceLevel,
        trustedRootCerts:       trustedRoots,
      });
      if (!x509Result.valid) {
        return fail(step,
          x509Result.errorCode ?? ec.CERT_FORMAT_INVALID,
          x509Result.message   ?? "X.509 chain validation failed");
      }
    }
    return ok();
  }

  // ── Revocation (Step 4) — parity with .NET CheckRevocationAsync ────────────

  private async checkRevocation(
    frame: IdentFrame, signal?: AbortSignal,
  ): Promise<NipIdentVerifyResult> {
    const serial = identSerial(frame);
    const opts = this.options;

    // Local CRL first (fast, no network).
    if (serial !== undefined) {
      const local = opts.localRevokedSerials;
      const revoked = local instanceof Set
        ? local.has(serial)
        : Array.isArray(local)
          ? local.includes(serial)
          : false;
      if (revoked) {
        return fail(4, ec.CERT_REVOKED,
          `Certificate serial ${serial} is in the local revocation list.`);
      }
    }

    // Live revocation callback.
    if (opts.revocationCheck) {
      const cbResult = await opts.revocationCheck(frame, signal);
      if (cbResult && cbResult.valid === false) return cbResult;
    }

    // Revocation store lookup by serial.
    if (opts.revocationStore && serial !== undefined) {
      const record = await opts.revocationStore.getBySerial(serial, signal);
      if (record && record.revokedAt) {
        return fail(4, ec.CERT_REVOKED,
          `Certificate serial ${serial} was revoked at ${record.revokedAt}: ${record.revokeReason ?? ""}`);
      }
    }

    // OCSP call (optional).
    if (opts.ocspUrl) {
      return this.ocspCheck(frame.nid, signal);
    }

    // Pass-through when revocation is unconfigured.
    return ok();
  }

  private async ocspCheck(nid: string, signal?: AbortSignal): Promise<NipIdentVerifyResult> {
    const doFetch = this.options.fetch ?? fetch;
    const base = this.options.ocspUrl!.replace(/\/+$/, "");
    const url  = `${base}/${encodeURIComponent(nid)}`;
    try {
      const resp = await doFetch(url, { signal });
      if (!resp.ok) {
        return fail(4, ec.OCSP_UNAVAILABLE,
          `OCSP endpoint returned ${resp.status}.`);
      }
      const body = (await resp.json()) as { valid?: unknown; error_code?: unknown };
      const isValid = body?.valid === true;
      if (!isValid) {
        const errorCode = typeof body?.error_code === "string"
          ? body.error_code
          : ec.CERT_REVOKED;
        return fail(4, errorCode, `OCSP check failed for NID ${nid}.`);
      }
      return ok();
    } catch (e) {
      if (this.options.ocspFailOpen) {
        return ok();
      }
      return fail(4, ec.OCSP_UNAVAILABLE,
        `OCSP call failed for NID ${nid}: ${(e as Error).message}`);
    }
  }

  // ── Scope check (Step 6) — parity with .NET CheckScope ─────────────────────

  private static checkScope(frame: IdentFrame, targetPath: string): NipIdentVerifyResult {
    const nodes = identScopeNodes(frame);
    if (nodes === undefined) {
      return fail(6, ec.CERT_SCOPE_VIOLATION, "IdentFrame scope is missing 'nodes' field.");
    }
    for (const pattern of nodes) {
      if (typeof pattern === "string" && NipIdentVerifier.nwpPathMatches(pattern, targetPath)) {
        return ok();
      }
    }
    return fail(6, ec.CERT_SCOPE_VIOLATION,
      `Target path '${targetPath}' is not covered by the certificate scope.`);
  }

  /**
   * Matches a NWP path against a scope pattern (parity with .NET NwpPathMatches):
   *  - bare `*` matches any path
   *  - trailing `/*` matches the prefix and any path under it (at a `/` boundary)
   *  - otherwise a case-insensitive exact match
   */
  static nwpPathMatches(pattern: string, path: string): boolean {
    if (pattern === "*") return true;

    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2); // strip "/*"
      const lp = path.toLowerCase();
      const lprefix = prefix.toLowerCase();
      return lp.startsWith(lprefix)
        && (path.length === prefix.length || path[prefix.length] === "/");
    }

    return pattern.toLowerCase() === path.toLowerCase();
  }
}

// ── Frame-shape adapters ──────────────────────────────────────────────────────
//
// The TS IdentFrame carries issuer/expiry/capabilities/scope inside `metadata`
// (see frames.ts). The .NET reference uses flat top-level fields plus a
// `scope: { nodes: [...] }` object. These adapters read the equivalent data
// from the TS shape so the six-step flow behaves identically.

/** Reads the certificate serial, if present, from metadata. */
function identSerial(frame: IdentFrame): string | undefined {
  const meta = frame.metadata as unknown as Record<string, unknown>;
  const s = meta["serial"];
  return typeof s === "string" ? s : undefined;
}

/**
 * Reads the scope node patterns. Returns `undefined` when no `nodes`/`scopes`
 * field is present at all (mirrors the .NET "missing 'nodes' field" failure);
 * returns `[]` when the field exists but is empty.
 */
function identScopeNodes(frame: IdentFrame): readonly unknown[] | undefined {
  const meta = frame.metadata as unknown as Record<string, unknown>;
  // Prefer an explicit `scope: { nodes: [...] }` object (matches .NET wire shape).
  const scope = meta["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const nodes = (scope as Record<string, unknown>)["nodes"];
    return Array.isArray(nodes) ? nodes : undefined;
  }
  // Otherwise fall back to the flat `scopes: string[]` carried by IdentMetadata.
  const scopes = meta["scopes"];
  return Array.isArray(scopes) ? scopes : undefined;
}

/**
 * Canonical JSON matching NipIdentity.sign — top-level keys filtered/ordered
 * via `Object.keys(payload).sort()` as JSON.stringify replacer.
 */
function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/** Parse `ed25519:<hex>` or `ed25519:<base64>` value into a 32-byte key. */
function parsePubKeyString(s: string): Uint8Array {
  if (!s.startsWith("ed25519:")) {
    throw new Error(`Unsupported public key format: ${s}`);
  }
  const body = s.slice("ed25519:".length);
  const hex = /^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0;
  const bytes = hex
    ? new Uint8Array(Buffer.from(body, "hex"))
    : new Uint8Array(Buffer.from(body, "base64"));
  if (bytes.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Decode a base64 (or hex) signature body into a 64-byte signature. */
function decodeSignature(body: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(body, "base64"));
  if (bytes.length === 64) return bytes;
  if (/^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0) {
    const hexBytes = new Uint8Array(Buffer.from(body, "hex"));
    if (hexBytes.length === 64) return hexBytes;
  }
  return bytes; // let ed25519.verify surface the length error
}
