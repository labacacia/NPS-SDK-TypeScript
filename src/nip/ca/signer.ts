// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NipCaSigner — Ed25519 signing/verification and canonical-JSON helpers for the
 * NIP CA service library. Mirrors the .NET `NPS.NIP.Crypto.NipSigner`
 * canonical form: keys are serialised in alphabetical order (RFC 8785-style
 * JCS ordering), the payload is UTF-8 encoded, signed with Ed25519, and the
 * signature is returned as `ed25519:<base64url>`.
 *
 * Backed by `node:crypto` (Ed25519, Node ≥ 22) — the same primitive used by
 * the standalone `nip-ca-server`.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

// ── base64url helpers ──────────────────────────────────────────────────────────

export function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ── Canonical JSON (JCS-style alphabetical key ordering, recursive) ────────────

/**
 * Recursively re-serialises `value` with object keys in ascending Unicode
 * code-point order, matching .NET `NipSigner.CanonicalJson`. Arrays keep their
 * order; scalars are emitted verbatim.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // absent fields are omitted
    out[key] = canonicalise(v);
  }
  return out;
}

// ── Key material ────────────────────────────────────────────────────────────────

/** Wrapper around an Ed25519 keypair used by the CA. */
export class NipCaKeyPair {
  private constructor(
    readonly privateKey: KeyObject,
    readonly publicKey: KeyObject,
  ) {}

  static generate(): NipCaKeyPair {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new NipCaKeyPair(privateKey, publicKey);
  }

  /** Build from a 32-byte raw Ed25519 seed. */
  static fromRawSeed(seed: Uint8Array): NipCaKeyPair {
    if (seed.length !== 32) throw new Error(`Ed25519 seed must be 32 bytes; got ${seed.length}.`);
    // PKCS8 prefix for an Ed25519 private key.
    const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
    const der = Buffer.concat([pkcs8Header, Buffer.from(seed)]);
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    return new NipCaKeyPair(privateKey, publicKey);
  }

  static fromPrivateKey(privateKey: KeyObject): NipCaKeyPair {
    return new NipCaKeyPair(privateKey, createPublicKey(privateKey));
  }

  /** Raw 32-byte public key. */
  rawPublicKey(): Uint8Array {
    const der = this.publicKey.export({ type: "spki", format: "der" });
    return new Uint8Array(der.subarray(der.length - 32));
  }

  /** Public key in `ed25519:<base64url>` form. */
  publicKeyString(): string {
    return encodePublicKey(this.rawPublicKey());
  }
}

// ── Signing ─────────────────────────────────────────────────────────────────────

/** Signs a JSON artifact with the CA key. Returns `ed25519:<base64url>`. */
export function signArtifact(privateKey: KeyObject, artifact: unknown): string {
  const bytes = Buffer.from(canonicalJson(artifact), "utf8");
  const sig = edSign(null, bytes, privateKey);
  return `ed25519:${sig.toString("base64url")}`;
}

/** Verifies an `ed25519:<base64url>` signature over a canonical JSON artifact. */
export function verifyArtifact(publicKey: KeyObject, artifact: unknown, signature: string): boolean {
  if (!signature.startsWith("ed25519:")) return false;
  try {
    const bytes = Buffer.from(canonicalJson(artifact), "utf8");
    const sig = Buffer.from(signature.slice("ed25519:".length), "base64url");
    return edVerify(null, bytes, publicKey, sig);
  } catch {
    return false;
  }
}

// ── Public-key encode/decode ────────────────────────────────────────────────────

export function encodePublicKey(raw: Uint8Array): string {
  return `ed25519:${Buffer.from(raw).toString("base64url")}`;
}

/** Decode an `ed25519:<base64url>` public key into a KeyObject, or null. */
export function decodePublicKey(encoded: string): KeyObject | null {
  const raw = extractEd25519Raw(encoded);
  if (raw === null) return null;
  const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([spkiHeader, Buffer.from(raw)]);
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** Extract the raw 32-byte key from an `ed25519:<base64url>` string, or null. */
export function extractEd25519Raw(encoded: string): Uint8Array | null {
  const prefix = "ed25519:";
  if (!encoded.startsWith(prefix)) return null;
  try {
    const raw = fromBase64Url(encoded.slice(prefix.length));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}
