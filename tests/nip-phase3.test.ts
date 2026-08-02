// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NIP v0.12 §7.5 Phase-3 enforcement. Ports tests/NPS.Tests/Nip/NipPhase3EnforcerTests.cs
// (the 8 scenarios of brief B Part 1 §6) plus the four extras that brief calls for.

import { describe, expect, it } from "vitest";
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import * as x509 from "@peculiar/x509";

import { AssuranceLevel } from "../src/nip/assurance-level.js";
import { V2_X509 } from "../src/nip/cert-format.js";
import * as ec from "../src/nip/error-codes.js";
import { IdentFrame, type IdentMetadata } from "../src/nip/frames.js";
import {
  enforcePhase3,
  readUtf8SequenceExtension,
  tryGetOcspNextUpdate,
} from "../src/nip/phase3-enforcer.js";
import { NipIdentVerifier } from "../src/nip/verifier.js";
import { derEncode, derEncodeUtf8Sequence } from "../src/nip/x509/der.js";
import { ID_NPS_CAPABILITIES, ID_NPS_NODE_ROLES } from "../src/nip/x509/oids.js";
import { issueRoot } from "../src/nip/x509/builder.js";
import { generateDualKeyPair } from "./_rfc0002-keys.js";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));
x509.cryptoProvider.set(globalThis.crypto);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The .NET fixture's fixed clock. */
const NOW = new Date("2026-07-05T12:00:00Z");

const BASE_METADATA: IdentMetadata = {
  issuer:       "urn:nps:org:example.com",
  issuedAt:     "2026-07-01T00:00:00Z",
  expiresAt:    "2026-08-01T00:00:00Z",
  capabilities: ["nwp:query"],
};

function identFrame(opts: {
  capabilities?: string[];
  nodeRoles?: string[] | null;
  ocspStaple?: string | null;
  certFormat?: string | null;
} = {}): IdentFrame {
  return new IdentFrame(
    "urn:nps:agent:ca.example.com:p3-001",
    "ed25519:AAAA",
    { ...BASE_METADATA, capabilities: opts.capabilities ?? ["nwp:query"] },
    "ed25519:test",
    {
      certFormat: opts.certFormat === undefined ? V2_X509 : opts.certFormat,
      nodeRoles:  opts.nodeRoles === undefined ? ["memory"] : opts.nodeRoles,
      ocspStaple: opts.ocspStaple === undefined ? staple(hoursFrom(NOW, 6)) : opts.ocspStaple,
    },
  );
}

/** Self-signed ECDSA P-256 leaf, CN=phase3-test, optional id-nps-* attestation extensions. */
async function testCert(opts: {
  roles?: readonly string[];
  caps?: readonly string[];
  /** Inject raw (possibly malformed) DER instead of a well-formed SEQUENCE OF UTF8String. */
  rawRolesDer?: Uint8Array;
} = {}): Promise<x509.X509Certificate> {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const extensions: x509.Extension[] = [];
  if (opts.rawRolesDer) {
    extensions.push(new x509.Extension(ID_NPS_NODE_ROLES, false, opts.rawRolesDer.buffer as ArrayBuffer));
  } else if (opts.roles) {
    extensions.push(new x509.Extension(
      ID_NPS_NODE_ROLES, false, derEncodeUtf8Sequence(opts.roles).buffer as ArrayBuffer));
  }
  if (opts.caps) {
    extensions.push(new x509.Extension(
      ID_NPS_CAPABILITIES, false, derEncodeUtf8Sequence(opts.caps).buffer as ArrayBuffer));
  }
  return x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=phase3-test",
    notBefore: new Date(NOW.getTime() - 86_400_000),
    notAfter:  new Date(NOW.getTime() + 30 * 86_400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keys as CryptoKeyPair,
    extensions,
  });
}

// ── Minimal hand-built RFC 6960 OCSPResponse ─────────────────────────────────

const TAG_ENUMERATED = 0x0a, TAG_OID = 0x06, TAG_OCTET = 0x04;
const TAG_SEQ = 0x30, TAG_GENTIME = 0x18, TAG_CTX0 = 0xa0, TAG_CTX1 = 0xa1;
/** id-pkix-ocsp-basic = 1.3.6.1.5.5.7.48.1.1 */
const OCSP_BASIC_OID = new Uint8Array([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01, 0x01]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function genTime(d: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
            `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return derEncode(TAG_GENTIME, new TextEncoder().encode(s));
}

/** Build an OCSPResponse DER whose first SingleResponse carries `nextUpdate` (or omits it). */
function ocspDer(nextUpdate: Date | null): Uint8Array {
  const single = derEncode(TAG_SEQ, concat(
    derEncode(TAG_SEQ, new Uint8Array(0)),       // certID
    derEncode(0x80, new Uint8Array(0)),           // certStatus: [0] IMPLICIT good
    genTime(new Date(NOW.getTime() - 3600_000)),  // thisUpdate
    ...(nextUpdate ? [derEncode(TAG_CTX0, genTime(nextUpdate))] : []),
  ));
  const responseData = derEncode(TAG_SEQ, concat(
    derEncode(TAG_CTX1, derEncode(TAG_SEQ, new Uint8Array(0))),  // responderID [1] byName
    genTime(NOW),                                                // producedAt
    derEncode(TAG_SEQ, single),                                  // responses
  ));
  const basic = derEncode(TAG_SEQ, concat(
    responseData,
    derEncode(TAG_SEQ, new Uint8Array(0)),        // signatureAlgorithm
    derEncode(0x03, new Uint8Array([0x00])),      // signature BIT STRING
  ));
  return derEncode(TAG_SEQ, concat(
    derEncode(TAG_ENUMERATED, new Uint8Array([0x00])),                       // successful
    derEncode(TAG_CTX0, derEncode(TAG_SEQ, concat(
      derEncode(TAG_OID, OCSP_BASIC_OID),
      derEncode(TAG_OCTET, basic),
    ))),
  ));
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

function staple(nextUpdate: Date | null): string { return b64u(ocspDer(nextUpdate)); }
function hoursFrom(d: Date, h: number): Date { return new Date(d.getTime() + h * 3600_000); }

// ── The 8 reference scenarios ────────────────────────────────────────────────

describe("NipPhase3Enforcer (NIP v0.12 §7.5)", () => {
  it("1. subset claims with a fresh staple pass", async () => {
    const cert = await testCert({ roles: ["memory", "anchor"], caps: ["nwp:query", "nwp:action"] });
    const frame = identFrame({ nodeRoles: ["memory"], capabilities: ["nwp:query"] });
    expect(enforcePhase3(frame, cert, NOW)).toEqual({ valid: true, stepFailed: 0 });
  });

  it("2. an unattested role fails with NIP-CERT-NODE-ROLES-MISMATCH", async () => {
    const cert = await testCert({ roles: ["memory"] });
    const frame = identFrame({ nodeRoles: ["memory", "orchestrator"] });
    const r = enforcePhase3(frame, cert, NOW);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.CERT_NODE_ROLES_MISMATCH);
    expect(r.stepFailed).toBe(3);
    expect(r.message).toContain("orchestrator");
  });

  it("3. an unattested capability fails with NIP-CERT-CAPABILITIES-EXCEEDED", async () => {
    const cert = await testCert({ caps: ["nwp:query"] });
    const frame = identFrame({ nodeRoles: null, capabilities: ["nwp:query", "nop:orchestrate"] });
    const r = enforcePhase3(frame, cert, NOW);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.CERT_CAPABILITIES_EXCEEDED);
    expect(r.message).toContain("nop:orchestrate");
  });

  it("4. no id-nps-* extensions means the attribute checks do not apply", async () => {
    const cert = await testCert();
    const frame = identFrame({ nodeRoles: ["anything"], capabilities: ["anything:at:all"] });
    expect(enforcePhase3(frame, cert, NOW).valid).toBe(true);
  });

  it("5. a missing staple fails", async () => {
    const cert = await testCert();
    const r = enforcePhase3(identFrame({ ocspStaple: null }), cert, NOW);
    expect(r.errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
    expect(r.message).toContain("none was supplied");
  });

  it("6. an expired staple fails with a message mentioning 'elapsed'", async () => {
    const cert = await testCert();
    const frame = identFrame({ ocspStaple: staple(new Date(NOW.getTime() - 60_000)) });
    const r = enforcePhase3(frame, cert, NOW);
    expect(r.errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
    expect(r.message).toContain("elapsed");
  });

  it("7. a malformed staple fails closed", async () => {
    const cert = await testCert();
    const r = enforcePhase3(identFrame({ ocspStaple: "bm90LWFuLW9jc3A" }), cert, NOW);
    expect(r.errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
  });

  it("8. the UTF8 sequence extension parses, and an absent one reads as null", async () => {
    const cert = await testCert({ roles: ["memory", "anchor"] });
    expect(readUtf8SequenceExtension(cert, ID_NPS_NODE_ROLES)).toEqual(["memory", "anchor"]);
    expect(readUtf8SequenceExtension(cert, ID_NPS_CAPABILITIES)).toBeNull();
  });
});

// ── The additional cases brief B §6 asks ports to add ────────────────────────

describe("NipPhase3Enforcer — additional port coverage", () => {
  it("a malformed extension is treated as [] (present-but-empty), so any claim fails", async () => {
    const cert = await testCert({ rawRolesDer: new Uint8Array([0x30, 0x05, 0x0c, 0x7f, 0x41]) });
    expect(readUtf8SequenceExtension(cert, ID_NPS_NODE_ROLES)).toEqual([]);
    const r = enforcePhase3(identFrame({ nodeRoles: ["memory"] }), cert, NOW);
    expect(r.errorCode).toBe(ec.CERT_NODE_ROLES_MISMATCH);
  });

  it("distinguishes 'absent' (null) from 'present but empty' ([])", async () => {
    const empty = await testCert({ roles: [] });
    expect(readUtf8SequenceExtension(empty, ID_NPS_NODE_ROLES)).toEqual([]);
    expect(enforcePhase3(identFrame({ nodeRoles: ["memory"] }), empty, NOW).errorCode)
      .toBe(ec.CERT_NODE_ROLES_MISMATCH);
    // …while an absent extension skips the check entirely
    expect(enforcePhase3(identFrame({ nodeRoles: ["memory"] }), await testCert(), NOW).valid).toBe(true);
  });

  it("nextUpdate exactly == now fails (the comparison is `<=`, not `<`)", async () => {
    const r = enforcePhase3(identFrame({ ocspStaple: staple(NOW) }), await testCert(), NOW);
    expect(r.errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
  });

  it("a staple with no nextUpdate fails closed", async () => {
    const r = enforcePhase3(identFrame({ ocspStaple: staple(null) }), await testCert(), NOW);
    expect(r.errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
    expect(r.message).toContain("nextUpdate");
  });

  it("evaluation order is node_roles → capabilities → OCSP staple", async () => {
    // All three would fail; the roles failure must win.
    const cert = await testCert({ roles: [], caps: [] });
    const frame = identFrame({ nodeRoles: ["memory"], capabilities: ["nwp:query"], ocspStaple: null });
    expect(enforcePhase3(frame, cert, NOW).errorCode).toBe(ec.CERT_NODE_ROLES_MISMATCH);
    // …then capabilities, before the staple.
    const frame2 = identFrame({ nodeRoles: [], capabilities: ["nwp:query"], ocspStaple: null });
    expect(enforcePhase3(frame2, cert, NOW).errorCode).toBe(ec.CERT_CAPABILITIES_EXCEEDED);
  });

  it("comparison is ordinal — no case folding, no trimming", async () => {
    const cert = await testCert({ roles: ["memory"] });
    expect(enforcePhase3(identFrame({ nodeRoles: ["Memory"] }), cert, NOW).errorCode)
      .toBe(ec.CERT_NODE_ROLES_MISMATCH);
    expect(enforcePhase3(identFrame({ nodeRoles: [" memory"] }), cert, NOW).errorCode)
      .toBe(ec.CERT_NODE_ROLES_MISMATCH);
  });

  it("node_roles == null is an empty set, so it is always a subset", async () => {
    const cert = await testCert({ roles: ["memory"] });
    expect(enforcePhase3(identFrame({ nodeRoles: null }), cert, NOW).valid).toBe(true);
  });

  it("validates its arguments", async () => {
    const cert = await testCert();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => enforcePhase3(null as any, cert, NOW)).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => enforcePhase3(identFrame(), null as any, NOW)).toThrow(TypeError);
  });

  it("NIP-CERT-CAPABILITIES-EXCEEDED maps to NPS-AUTH-FORBIDDEN (asymmetric with its sibling)", async () => {
    const { NIP_ERROR_TO_NPS_STATUS } = await import("../src/nip/error-codes.js");
    expect(NIP_ERROR_TO_NPS_STATUS[ec.CERT_CAPABILITIES_EXCEEDED]).toBe("NPS-AUTH-FORBIDDEN");
  });
});

// ── tryGetOcspNextUpdate directly ────────────────────────────────────────────

describe("tryGetOcspNextUpdate", () => {
  it("reads the first SingleResponse's nextUpdate", () => {
    const nu = hoursFrom(NOW, 6);
    expect(tryGetOcspNextUpdate(ocspDer(nu))?.toISOString()).toBe(nu.toISOString());
  });

  it("returns null on garbage rather than throwing", () => {
    expect(tryGetOcspNextUpdate(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(tryGetOcspNextUpdate(new Uint8Array(0))).toBeNull();
  });

  it("returns null when responseBytes is absent", () => {
    const der = derEncode(TAG_SEQ, derEncode(TAG_ENUMERATED, new Uint8Array([0x06])));
    expect(tryGetOcspNextUpdate(der)).toBeNull();
  });
});

// ── Verifier integration — step 3c and the policy flag ───────────────────────

describe("NipIdentVerifier step 3c (phase3Enforcement)", () => {
  const CA_NID = "urn:nps:org:example.com";
  const AGENT_NID = "urn:nps:agent:ca.example.com:p3-001";

  /** Build a real chain whose leaf carries id-nps-* extensions, plus a signed v2 frame. */
  async function scenario(opts: {
    certCaps?: string[];
    frameCaps?: string[];
    ocspStaple?: string | null;
    certFormat?: string | null;
  }) {
    const ca = await generateDualKeyPair();
    const agent = await generateDualKeyPair();
    const root = await issueRoot({
      caNid: CA_NID, caKeys: ca.webCrypto,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 365 * 86_400_000),
      serialNumber: "01",
    });
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      issuer: `CN=${CA_NID}`,
      subject: `CN=${AGENT_NID}`,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 30 * 86_400_000),
      publicKey: agent.webCrypto.publicKey,
      signingAlgorithm: { name: "Ed25519" },
      signingKey: ca.webCrypto.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(["1.3.6.1.4.1.65715.1.1"], true),
        new x509.SubjectAlternativeNameExtension([{ type: "url", value: AGENT_NID }], false),
        new x509.Extension(ID_NPS_CAPABILITIES, false,
          derEncodeUtf8Sequence(opts.certCaps ?? ["nwp:query"]).buffer as ArrayBuffer),
      ],
    });

    const pubKeyStr = "ed25519:" + Buffer.from(agent.pubRaw).toString("hex");
    const metadata: IdentMetadata = { ...BASE_METADATA, capabilities: opts.frameCaps ?? ["nwp:query"] };
    const unsigned = { nid: AGENT_NID, pub_key: pubKeyStr, metadata };
    const canonical = JSON.stringify(unsigned, Object.keys(unsigned).sort());
    const sig = "ed25519:" + Buffer.from(
      ed25519.sign(new TextEncoder().encode(canonical), ca.privRaw)).toString("base64");

    const frame = new IdentFrame(AGENT_NID, pubKeyStr, metadata, sig, {
      assuranceLevel: null,
      certFormat: opts.certFormat === undefined ? V2_X509 : opts.certFormat,
      certChain: [b64u(new Uint8Array(leaf.rawData)), b64u(new Uint8Array(root.rawData))],
      ocspStaple: opts.ocspStaple === undefined
        ? staple(new Date(Date.now() + 6 * 3600_000))
        : opts.ocspStaple,
    });

    return { frame, root, caPubHex: "ed25519:" + Buffer.from(ca.pubRaw).toString("hex") };
  }

  it("defaults to false — a Phase-3-failing frame still verifies (advisory only)", async () => {
    const s = await scenario({ certCaps: ["nwp:query"], frameCaps: ["nwp:query", "nop:orchestrate"] });
    const v = new NipIdentVerifier({
      trustedCaPublicKeys: { [CA_NID]: s.caPubHex }, trustedX509Roots: [s.root],
    });
    expect((await v.verify(s.frame, CA_NID)).valid).toBe(true);
  });

  it("with the flag on, an over-claiming frame is rejected at step 3", async () => {
    const s = await scenario({ certCaps: ["nwp:query"], frameCaps: ["nwp:query", "nop:orchestrate"] });
    const v = new NipIdentVerifier({
      trustedCaPublicKeys: { [CA_NID]: s.caPubHex }, trustedX509Roots: [s.root],
      phase3Enforcement: true,
    });
    const r = await v.verify(s.frame, CA_NID);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.CERT_CAPABILITIES_EXCEEDED);
    expect(r.stepFailed).toBe(3);
  });

  it("with the flag on, a conforming frame with a fresh staple passes", async () => {
    const s = await scenario({ certCaps: ["nwp:query", "nwp:action"], frameCaps: ["nwp:query"] });
    const v = new NipIdentVerifier({
      trustedCaPublicKeys: { [CA_NID]: s.caPubHex }, trustedX509Roots: [s.root],
      phase3Enforcement: true,
    });
    expect((await v.verify(s.frame, CA_NID)).valid).toBe(true);
  });

  it("with the flag on, a v2-x509 frame with no staple is rejected", async () => {
    const s = await scenario({ ocspStaple: null });
    const v = new NipIdentVerifier({
      trustedCaPublicKeys: { [CA_NID]: s.caPubHex }, trustedX509Roots: [s.root],
      phase3Enforcement: true,
    });
    expect((await v.verify(s.frame, CA_NID)).errorCode).toBe(ec.OCSP_STAPLE_EXPIRED);
  });

  it("a non-v2-x509 frame never reaches the enforcer, flag or not", async () => {
    // cert_format null ⇒ v1; step 3b (and therefore 3c) is skipped entirely.
    const s = await scenario({ certFormat: null, ocspStaple: null, frameCaps: ["over:claimed"] });
    const v = new NipIdentVerifier({
      trustedCaPublicKeys: { [CA_NID]: s.caPubHex }, trustedX509Roots: [s.root],
      phase3Enforcement: true,
    });
    expect((await v.verify(s.frame, CA_NID)).valid).toBe(true);
  });
});
