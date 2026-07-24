// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

// TypeScript parallel of the .NET NipIdentVerifierTests — full NPS-3 §7 six-step
// IdentFrame flow, plus TrustFrameValidator and the NwpPathMatches scope helper.

import { describe, expect, it } from "vitest";

import { NipIdentity } from "../src/nip/identity.js";
import { IdentFrame, TrustFrame } from "../src/nip/frames.js";
import {
  NipIdentVerifier,
  type NipVerifierOptions,
  type NipVerifyContext,
} from "../src/nip/verifier.js";
import { validateTrustFrame } from "../src/nip/trust-frame-validator.js";
import * as ec from "../src/nip/error-codes.js";

// ── Shared fixture ────────────────────────────────────────────────────────────

const CA_NID    = "urn:nps:org:ca.verifier-test.example";
const AGENT_NID = "urn:nps:agent:ca.verifier-test.example:agent-001";
const SERIAL    = "0xABC001";

const ca = NipIdentity.generate();

interface MakeFrameOpts {
  expiresAt?:    Date;
  issuedBy?:     string;
  caps?:         string[];
  scopeNodes?:   string[];
  serial?:       string;
  tamperPubKey?: string;
}

/** Build and sign a well-formed IdentFrame covering nwp://api.test.example/*. */
function makeFrame(o: MakeFrameOpts = {}): IdentFrame {
  const now = new Date();
  const exp = (o.expiresAt ?? new Date(now.getTime() + 86_400_000)).toISOString();
  const iss = o.issuedBy ?? CA_NID;
  const caps = o.caps ?? ["nwp:query", "nwp:stream"];
  const nodes = o.scopeNodes ?? ["nwp://api.test.example/*"];
  const serial = o.serial ?? SERIAL;

  const metadata = {
    issuer:       iss,
    issuedAt:     now.toISOString(),
    expiresAt:    exp,
    capabilities: caps,
    scope:        { nodes },
    serial,
  } as unknown as IdentFrame["metadata"];

  const frame = new IdentFrame(AGENT_NID, ca.pubKeyString, metadata, "");
  const signature = ca.sign(frame.unsignedDict());

  // Tamper a *signed* top-level field (pub_key) after signing so the Ed25519
  // signature no longer matches — mirrors the .NET "tampered frame" case.
  const pubKey = o.tamperPubKey ?? ca.pubKeyString;
  return new IdentFrame(AGENT_NID, pubKey, metadata, signature);
}

function baseOpts(over: Partial<NipVerifierOptions> = {}): NipVerifierOptions {
  return { trustedIssuers: { [CA_NID]: ca.pubKeyString }, ...over };
}

// ── Step 1: Expiry ────────────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 1 expiry", () => {
  it("expired frame fails with NIP-CERT-EXPIRED", async () => {
    const frame = makeFrame({ expiresAt: new Date(Date.now() - 86_400_000) });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { asOf: new Date() });
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(1);
    expect(r.errorCode).toBe(ec.CERT_EXPIRED);
  });

  it("invalid expires_at fails at step 1", async () => {
    const frame = makeFrame();
    (frame.metadata as { expiresAt: string }).expiresAt = "not-a-date";
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(1);
    expect(r.errorCode).toBe(ec.CERT_EXPIRED);
  });

  it("future frame does not fail at step 1", async () => {
    const frame = makeFrame({ expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { asOf: new Date() });
    if (!r.valid) expect(r.stepFailed).not.toBe(1);
  });
});

// ── Step 2: Trusted issuer ─────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 2 trusted issuer", () => {
  it("unknown issuer fails with NIP-CERT-UNTRUSTED-ISSUER", async () => {
    const frame = makeFrame({ issuedBy: "urn:nps:org:unknown.ca" });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(2);
    expect(r.errorCode).toBe(ec.CERT_UNTRUSTED_ISSUER);
  });

  it("empty trusted issuers fails at step 2", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier({ trustedIssuers: {} });
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(2);
  });
});

// ── Step 3: Signature ──────────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 3 signature", () => {
  it("invalid public key encoding fails at step 3", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier({ trustedIssuers: { [CA_NID]: "ed25519:!!!notvalid!!!" } });
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(3);
    expect(r.errorCode).toBe(ec.CERT_SIGNATURE_INVALID);
  });

  it("tampered frame fails signature", async () => {
    const frame = makeFrame({ tamperPubKey: NipIdentity.generate().pubKeyString });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(3);
    expect(r.errorCode).toBe(ec.CERT_SIGNATURE_INVALID);
  });

  it("wrong signing key fails signature", async () => {
    const frame = makeFrame();
    const wrong = NipIdentity.generate();
    const v = new NipIdentVerifier({ trustedIssuers: { [CA_NID]: wrong.pubKeyString } });
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(3);
    expect(r.errorCode).toBe(ec.CERT_SIGNATURE_INVALID);
  });
});

// ── Step 4: Revocation ──────────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 4 revocation (local CRL)", () => {
  it("revoked serial in local CRL fails", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({ localRevokedSerials: new Set([SERIAL]) }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.CERT_REVOKED);
  });

  it("other serial in local CRL passes step 4", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({ localRevokedSerials: new Set(["0xFFFFFF"]) }));
    const r = await v.verifyIdent(frame);
    if (!r.valid) expect(r.stepFailed).not.toBe(4);
  });
});

describe("NipIdentVerifier — Step 4 revocation (callback + store)", () => {
  it("live revocation callback rejects", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      revocationCheck: (f) => ({
        valid: false, stepFailed: 4, errorCode: ec.CERT_REVOKED,
        message: `Live revocation callback rejected ${f.metadata.issuer}.`,
      }),
    }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.CERT_REVOKED);
  });

  it("revocation store with revoked record rejects", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      revocationStore: {
        getBySerial: (serial) =>
          serial === SERIAL
            ? { serial, revokedAt: new Date().toISOString(), revokeReason: "banyan-test" }
            : null,
      },
    }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.CERT_REVOKED);
  });

  it("revocation store without a matching record passes step 4", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      revocationStore: { getBySerial: () => null },
    }));
    const r = await v.verifyIdent(frame);
    if (!r.valid) expect(r.stepFailed).not.toBe(4);
  });
});

describe("NipIdentVerifier — Step 4 revocation (OCSP)", () => {
  const okResp = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("OCSP valid response passes step 4", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      ocspUrl: "https://ocsp.test.example/nip",
      fetch:   okResp({ valid: true }),
    }));
    const r = await v.verifyIdent(frame);
    if (!r.valid) expect(r.stepFailed).not.toBe(4);
  });

  it("OCSP revoked response fails with returned error_code", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      ocspUrl: "https://ocsp.test.example/nip",
      fetch:   okResp({ valid: false, error_code: ec.CERT_REVOKED }),
    }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.CERT_REVOKED);
  });

  it("OCSP non-success status fails with NIP-OCSP-UNAVAILABLE", async () => {
    const frame = makeFrame();
    const v = new NipIdentVerifier(baseOpts({
      ocspUrl: "https://ocsp.test.example/nip",
      fetch:   okResp("", 503),
    }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.OCSP_UNAVAILABLE);
  });

  it("OCSP network error fails closed by default", async () => {
    const frame = makeFrame();
    const throwing = (async () => { throw new Error("Simulated network failure"); }) as unknown as typeof fetch;
    const v = new NipIdentVerifier(baseOpts({
      ocspUrl: "https://ocsp.test.example/nip",
      fetch:   throwing,
    }));
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(4);
    expect(r.errorCode).toBe(ec.OCSP_UNAVAILABLE);
  });

  it("OCSP network error fails open when enabled", async () => {
    const frame = makeFrame();
    const throwing = (async () => { throw new Error("Simulated network failure"); }) as unknown as typeof fetch;
    const v = new NipIdentVerifier(baseOpts({
      ocspUrl:      "https://ocsp.test.example/nip",
      ocspFailOpen: true,
      fetch:        throwing,
    }));
    const r = await v.verifyIdent(frame);
    if (!r.valid) expect(r.stepFailed).not.toBe(4);
  });
});

// ── Step 5: Capabilities ────────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 5 capabilities", () => {
  it("missing required capability fails", async () => {
    const frame = makeFrame({ caps: ["nwp:query"] });
    const v = new NipIdentVerifier(baseOpts());
    const ctx: NipVerifyContext = { requiredCapabilities: ["nwp:query", "nwp:write"] };
    const r = await v.verifyIdent(frame, ctx);
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(5);
    expect(r.errorCode).toBe(ec.CERT_CAPABILITY_MISSING);
    expect(r.message).toContain("nwp:write");
  });

  it("all required capabilities present passes step 5", async () => {
    const frame = makeFrame({ caps: ["nwp:query", "nwp:stream", "nwp:write"] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { requiredCapabilities: ["nwp:query", "nwp:write"] });
    if (!r.valid) expect(r.stepFailed).not.toBe(5);
  });

  it("no required capabilities skips step 5", async () => {
    const frame = makeFrame({ caps: [] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame);
    if (!r.valid) expect(r.stepFailed).not.toBe(5);
  });
});

// ── Step 6: Scope ────────────────────────────────────────────────────────────────

describe("NipIdentVerifier — Step 6 scope", () => {
  it("target path covered by wildcard passes", async () => {
    const frame = makeFrame({ scopeNodes: ["nwp://api.test.example/*"] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { targetNodePath: "nwp://api.test.example/products" });
    expect(r.valid).toBe(true);
  });

  it("target path not covered fails with NIP-CERT-SCOPE-VIOLATION", async () => {
    const frame = makeFrame({ scopeNodes: ["nwp://api.test.example/*"] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { targetNodePath: "nwp://other.domain.example/data" });
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(6);
    expect(r.errorCode).toBe(ec.CERT_SCOPE_VIOLATION);
  });

  it("missing nodes field fails at step 6", async () => {
    const frame = makeFrame();
    // Replace scope with an object lacking `nodes` and drop the flat `scopes`.
    (frame.metadata as unknown as Record<string, unknown>).scope = { actions: ["read"] };
    delete (frame.metadata as unknown as Record<string, unknown>).scopes;
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, { targetNodePath: "nwp://api.test.example/products" });
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(6);
    expect(r.errorCode).toBe(ec.CERT_SCOPE_VIOLATION);
  });

  it("null target path skips step 6", async () => {
    const frame = makeFrame({ scopeNodes: [] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame);
    expect(r.valid).toBe(true);
  });
});

// ── Full happy path ──────────────────────────────────────────────────────────────

describe("NipIdentVerifier — full six-step happy path", () => {
  it("valid frame with capabilities + scope succeeds", async () => {
    const frame = makeFrame({ caps: ["nwp:query", "nwp:stream"] });
    const v = new NipIdentVerifier(baseOpts());
    const r = await v.verifyIdent(frame, {
      requiredCapabilities: ["nwp:query"],
      targetNodePath:       "nwp://api.test.example/products",
    });
    expect(r.valid).toBe(true);
    expect(r.stepFailed).toBe(0);
    expect(r.errorCode).toBeUndefined();
  });
});

// ── NwpPathMatches ────────────────────────────────────────────────────────────────

describe("NwpPathMatches", () => {
  const cases: [string, string, boolean][] = [
    ["*", "nwp://anything.example/path", true],
    ["*", "", true],
    ["nwp://api.example.com/*", "nwp://api.example.com/products", true],
    ["nwp://api.example.com/*", "nwp://api.example.com/orders/123", true],
    ["nwp://api.example.com/*", "nwp://api.example.com", true],
    ["nwp://api.example.com/*", "nwp://api.example.com/", true],
    ["nwp://api.example.com/*", "nwp://other.example.com/products", false],
    ["nwp://api.example.com/exact", "nwp://api.example.com/exact", true],
    ["nwp://api.example.com/exact", "nwp://api.example.com/exact/sub", false],
    ["nwp://api.example.com/exact", "nwp://API.EXAMPLE.COM/EXACT", true],
    ["nwp://api.example.com/*", "nwp://API.EXAMPLE.COM/data", true],
    ["nwp://api.example.com/prefix*", "nwp://api.example.com/prefixstuff", false],
  ];
  it.each(cases)("nwpPathMatches(%s, %s) === %s", (pattern, path, expected) => {
    expect(NipIdentVerifier.nwpPathMatches(pattern, path)).toBe(expected);
  });
});

// ── TrustFrameValidator ──────────────────────────────────────────────────────────

describe("TrustFrameValidator", () => {
  const GRANTOR = "urn:nps:org:org-a.com";
  const GRANTEE = "urn:nps:org:org-b.com";

  function makeTrust(over: Partial<{
    expiresAt: string; grantor: string; grantee: string;
    trustScope: string[]; nodes: string[]; issuedAt: string; serial: string;
    signerNid: string; signature: string;
  }> = {}): TrustFrame {
    return new TrustFrame(
      over.grantor    ?? GRANTOR,
      over.grantee    ?? GRANTEE,
      over.trustScope ?? ["nwp:query"],
      over.nodes      ?? ["nwp://api.org-a.com/*"],
      over.issuedAt   ?? "2026-01-01T00:00:00Z",
      over.expiresAt  ?? new Date(Date.now() + 86_400_000).toISOString(),
      over.serial     ?? "00000000000A3F9C",
      over.signerNid  ?? GRANTOR,
      over.signature  ?? "ed25519:sig",
    );
  }

  it("valid TrustFrame passes", () => {
    const r = validateTrustFrame(makeTrust(), {
      trustedGrantors: new Set([GRANTOR]), expectedGranteeCa: GRANTEE,
      requiredCapabilities: ["nwp:query"], targetNodePath: "nwp://api.org-a.com/products",
    });
    expect(r.valid).toBe(true);
  });

  it("missing fields fail with NIP-TRUST-FRAME-INVALID", () => {
    const r = validateTrustFrame(makeTrust({ trustScope: [] }), {
      trustedGrantors: [GRANTOR], expectedGranteeCa: GRANTEE,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.TRUST_FRAME_INVALID);
  });

  it("expired TrustFrame fails with NIP-TRUST-FRAME-EXPIRED", () => {
    const r = validateTrustFrame(
      makeTrust({ expiresAt: new Date(Date.now() - 86_400_000).toISOString() }),
      { trustedGrantors: [GRANTOR], expectedGranteeCa: GRANTEE },
    );
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.TRUST_FRAME_EXPIRED);
  });

  it("untrusted grantor fails", () => {
    const r = validateTrustFrame(makeTrust(), {
      trustedGrantors: new Set(["urn:nps:org:someone-else"]), expectedGranteeCa: GRANTEE,
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.CERT_UNTRUSTED_ISSUER);
  });

  it("grantee CA mismatch fails", () => {
    const r = validateTrustFrame(makeTrust(), {
      trustedGrantors: [GRANTOR], expectedGranteeCa: "urn:nps:org:wrong",
    });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe(ec.TRUST_FRAME_INVALID);
  });

  it("scope exceeding grantor fails with NIP-TRUST-FRAME-SCOPE-EXCEEDS-GRANTOR", () => {
    const r = validateTrustFrame(makeTrust({ trustScope: ["nwp:query"] }), {
      trustedGrantors: [GRANTOR], expectedGranteeCa: GRANTEE,
      requiredCapabilities: ["nwp:query", "nwp:write"],
    });
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(5);
    expect(r.errorCode).toBe(ec.TRUST_FRAME_SCOPE_EXCEEDS_GRANTOR);
  });

  it("target path not covered fails with NIP-CERT-SCOPE-VIOLATION", () => {
    const r = validateTrustFrame(makeTrust({ nodes: ["nwp://api.org-a.com/*"] }), {
      trustedGrantors: [GRANTOR], expectedGranteeCa: GRANTEE,
      targetNodePath: "nwp://other.example/data",
    });
    expect(r.valid).toBe(false);
    expect(r.stepFailed).toBe(6);
    expect(r.errorCode).toBe(ec.CERT_SCOPE_VIOLATION);
  });
});
