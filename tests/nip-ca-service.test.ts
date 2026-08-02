// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BootstrapTokenPolicy,
  EnrollmentTier,
  InMemoryBootstrapTokenStore,
  InMemoryNipCaStore,
  InMemoryPendingStore,
  NipCaException,
  NipCaKeyPair,
  NipCaRouter,
  NipCaService,
  NID_ROLE_GROUP,
  NID_ROLE_SESSION,
  PendingQueuePolicy,
  tryVerify,
  type FlattenedJws,
  type NipCaOptions,
} from "../src/nip/ca/index.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeService(overrides: Partial<NipCaOptions> = {}): {
  ca: NipCaService;
  store: InMemoryNipCaStore;
  keys: NipCaKeyPair;
  options: NipCaOptions;
} {
  const store = new InMemoryNipCaStore();
  const keys = NipCaKeyPair.generate();
  const options: NipCaOptions = {
    caNid: "urn:nps:org:ca.example.com",
    baseUrl: "https://ca.example.com",
    ...overrides,
  };
  const ca = new NipCaService(options, store, keys);
  return { ca, store, keys, options };
}

const AGENT_PUB = NipCaKeyPair.generate().publicKeyString();

// ── register → verify ────────────────────────────────────────────────────────

describe("NipCaService register/verify", () => {
  it("registers an agent and verifies it as valid", async () => {
    const { ca } = makeService();
    const frame = await ca.register("agent", "a-001", AGENT_PUB, ["nwp:query"], "{}");
    expect(frame.frame).toBe("0x20");
    expect(frame.nid).toBe("urn:nps:agent:ca.example.com:a-001");
    expect(frame.signature.startsWith("ed25519:")).toBe(true);

    const result = await ca.verify(frame.nid);
    expect(result.valid).toBe(true);
    expect(result.record?.nid).toBe(frame.nid);
  });

  it("builds NID from the CA domain", () => {
    const { ca } = makeService();
    expect(ca.buildNid("node", "n1")).toBe("urn:nps:node:ca.example.com:n1");
  });

  it("rejects a duplicate NID with NIP-CA-NID-ALREADY-EXISTS", async () => {
    const { ca } = makeService();
    await ca.register("agent", "dup", AGENT_PUB, [], "{}");
    await expect(ca.register("agent", "dup", AGENT_PUB, [], "{}")).rejects.toMatchObject({
      errorCode: "NIP-CA-NID-ALREADY-EXISTS",
    });
  });

  it("verify returns NID-NOT-FOUND for unknown nid", async () => {
    const { ca } = makeService();
    const r = await ca.verify("urn:nps:agent:ca.example.com:nope");
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NIP-CA-NID-NOT-FOUND");
  });

  it("enforces allowedCapabilities", async () => {
    const { ca } = makeService({ allowedCapabilities: new Set(["nwp:query"]) });
    await expect(ca.register("agent", "x", AGENT_PUB, ["nwp:admin"], "{}")).rejects.toMatchObject({
      errorCode: "NIP-CERT-CAPABILITY-MISSING",
    });
  });
});

// ── renewal window ────────────────────────────────────────────────────────────

describe("NipCaService renew", () => {
  it("rejects renewal before the window opens", async () => {
    const { ca } = makeService({ agentCertValidityDays: 30, renewalWindowDays: 7 });
    const frame = await ca.register("agent", "r1", AGENT_PUB, [], "{}");
    await expect(ca.renew(frame.nid)).rejects.toMatchObject({ errorCode: "NIP-CA-RENEWAL-TOO-EARLY" });
  });

  it("allows renewal inside the window and issues a fresh serial", async () => {
    // validity 1 day, window 2 days → always inside the window immediately.
    const { ca } = makeService({ agentCertValidityDays: 1, renewalWindowDays: 2 });
    const frame = await ca.register("agent", "r2", AGENT_PUB, [], "{}");
    const renewed = await ca.renew(frame.nid);
    expect(renewed.nid).toBe(frame.nid);
    expect(renewed.serial).not.toBe(frame.serial);
  });
});

// ── revoke + cascade ──────────────────────────────────────────────────────────

describe("NipCaService revoke + group cascade", () => {
  it("revokes an agent and verify reports revoked", async () => {
    const { ca } = makeService();
    const frame = await ca.register("agent", "rv", AGENT_PUB, [], "{}");
    const rf = await ca.revoke(frame.nid, "key_compromise");
    expect(rf.frame).toBe("0x22");
    expect(rf.target_nid).toBe(frame.nid);
    expect(rf.reason).toBe("key_compromise");
    const r = await ca.verify(frame.nid);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NIP-CERT-REVOKED");
  });

  it("cascade-revokes live sessions when the group is revoked", async () => {
    const { ca } = makeService();
    const group = await ca.registerGroup("group-g1", AGENT_PUB, ["nwp:query"], "{}");
    const s1 = await ca.issueSession(group.nid, NipCaKeyPair.generate().publicKeyString());
    const s2 = await ca.issueSession(group.nid, NipCaKeyPair.generate().publicKeyString());

    await ca.revoke(group.nid, "ca_compromise");

    for (const s of [s1, s2]) {
      const r = await ca.verify(s.nid);
      expect(r.valid).toBe(false);
      // parent revoked short-circuits (record itself is also revoked → CERT-REVOKED)
      expect(["NIP-CERT-REVOKED", "NIP-CERT-PARENT-REVOKED"]).toContain(r.errorCode);
    }
    const crl = await ca.getCrl();
    expect(crl.length).toBe(3); // group + 2 sessions
  });
});

// ── group register + issue session (clamp + subset + lineage) ─────────────────

describe("NipCaService group / session", () => {
  it("registers a group with lineage.role=group", async () => {
    const { ca } = makeService();
    const g = await ca.registerGroup("group-x", AGENT_PUB, ["a", "b"], "{}", "user-1", "kid-1");
    expect(g.lineage?.role).toBe(NID_ROLE_GROUP);
    expect(g.lineage?.owner_user_id).toBe("user-1");
    const rec = await ca.getCert(g.nid);
    expect(rec?.nidRole).toBe(NID_ROLE_GROUP);
  });

  it("rejects a group identifier without the group- prefix", async () => {
    const { ca } = makeService();
    await expect(ca.registerGroup("nogroup", AGENT_PUB, [], "{}")).rejects.toBeInstanceOf(NipCaException);
  });

  it("issues a session with lineage pointing to the parent group", async () => {
    const { ca } = makeService();
    const g = await ca.registerGroup("group-s", AGENT_PUB, ["a", "b"], "{}", "u", "k");
    const s = await ca.issueSession(g.nid, NipCaKeyPair.generate().publicKeyString(), null, "run-1");
    expect(s.lineage?.role).toBe(NID_ROLE_SESSION);
    expect(s.lineage?.parent_nid).toBe(g.nid);
    expect(s.lineage?.group_nid).toBe(g.nid);
    expect(s.lineage?.purpose).toBe("run-1");
    // owner fields inherited from the group lineage
    expect(s.lineage?.owner_user_id).toBe("u");
  });

  it("clamps / rejects out-of-range session validity", async () => {
    const { ca } = makeService();
    const g = await ca.registerGroup("group-v", AGENT_PUB, [], "{}");
    // 1 second is below the 60s minimum
    await expect(
      ca.issueSession(g.nid, NipCaKeyPair.generate().publicKeyString(), 1000),
    ).rejects.toMatchObject({ errorCode: "NIP-CA-SESSION-VALIDITY-INVALID" });
  });

  it("enforces capability subset (no expansion past the group)", async () => {
    const { ca } = makeService();
    const g = await ca.registerGroup("group-c", AGENT_PUB, ["a"], "{}");
    await expect(
      ca.issueSession(g.nid, NipCaKeyPair.generate().publicKeyString(), null, null, ["a", "b"]),
    ).rejects.toMatchObject({ errorCode: "NIP-CA-SCOPE-EXPANSION-DENIED" });
  });

  it("defaults session caps/scope to the group's", async () => {
    const { ca } = makeService();
    const g = await ca.registerGroup("group-d", AGENT_PUB, ["a", "b"], '{"env":"prod"}');
    const s = await ca.issueSession(g.nid, NipCaKeyPair.generate().publicKeyString());
    expect(s.capabilities).toEqual(["a", "b"]);
    expect(s.scope).toEqual({ env: "prod" });
  });

  it("rejects issuing a session under an unknown group", async () => {
    const { ca } = makeService();
    await expect(
      ca.issueSession("urn:nps:agent:ca.example.com:group-missing", NipCaKeyPair.generate().publicKeyString()),
    ).rejects.toMatchObject({ errorCode: "NIP-CA-PARENT-NOT-FOUND" });
  });

  it("rejects issuing a session under a non-group NID", async () => {
    const { ca } = makeService();
    const a = await ca.register("agent", "plain", AGENT_PUB, [], "{}");
    await expect(
      ca.issueSession(a.nid, NipCaKeyPair.generate().publicKeyString()),
    ).rejects.toMatchObject({ errorCode: "NIP-CA-PARENT-NOT-GROUP" });
  });
});

// ── RA tiers ──────────────────────────────────────────────────────────────────

describe("RA enrollment tiers", () => {
  it("Tier 1 allowlist admits matching / rejects non-matching identifiers", async () => {
    const { ca, options } = makeService({
      enrollmentTier: EnrollmentTier.Allowlist,
      enrollmentAllowlistPatterns: ["svc-*"],
    });
    const policy = NipCaService.createEnrollmentPolicy(options);

    const ok = await ca.registerWithRa("agent", "svc-1", AGENT_PUB, [], "{}", null, null, policy);
    expect(ok.nid).toContain("svc-1");

    await expect(
      ca.registerWithRa("agent", "other", AGENT_PUB, [], "{}", null, null, policy),
    ).rejects.toMatchObject({ errorCode: "NIP-RA-NID-NOT-ALLOWED" });
  });

  it("Tier 2 bootstrap token: consumes a valid token, rejects reuse & bad tokens", async () => {
    const tokenStore = new InMemoryBootstrapTokenStore();
    const raw = await tokenStore.create("ci", new Date(Date.now() + 3600_000));
    const { ca } = makeService({ enrollmentTier: EnrollmentTier.BootstrapToken });
    const policy = new BootstrapTokenPolicy(tokenStore);

    const ok = await ca.registerWithRa("agent", "b1", AGENT_PUB, [], "{}", null, raw, policy);
    expect(ok.nid).toContain("b1");

    // reuse fails
    await expect(
      ca.registerWithRa("agent", "b2", AGENT_PUB, [], "{}", null, raw, policy),
    ).rejects.toMatchObject({ errorCode: "NIP-RA-TOKEN-EXPIRED" });

    // missing / malformed token fails
    await expect(
      ca.registerWithRa("agent", "b3", AGENT_PUB, [], "{}", null, "not-a-token", policy),
    ).rejects.toMatchObject({ errorCode: "NIP-RA-TOKEN-INVALID" });
  });

  it("Tier 3 pending queue: enqueues and surfaces a pending id", async () => {
    const pendingStore = new InMemoryPendingStore();
    const { ca } = makeService({ enrollmentTier: EnrollmentTier.PendingQueue });
    const policy = new PendingQueuePolicy(pendingStore, 1000);

    let pendingId: string | undefined;
    try {
      await ca.registerWithRa("agent", "p1", AGENT_PUB, [], "{}", null, null, policy);
    } catch (e) {
      pendingId = (e as { pendingId: string }).pendingId;
    }
    expect(pendingId).toBeTruthy();
    expect(pendingStore.pendingCount).toBe(1);

    const rec = await pendingStore.get(pendingId!);
    expect(rec?.identifier).toBe("p1");
    expect(await pendingStore.approve(pendingId!)).toBe(true);
  });

  it("createEnrollmentPolicy throws when a required store is missing", () => {
    const { options } = makeService({ enrollmentTier: EnrollmentTier.BootstrapToken });
    expect(() => NipCaService.createEnrollmentPolicy(options)).toThrow();
  });
});

// ── Group-JWS verify ──────────────────────────────────────────────────────────

function makeFlattenedJws(keys: NipCaKeyPair, kid: string, payload: object): FlattenedJws {
  const b64u = (o: object) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  const protectedHeader = b64u({ alg: "EdDSA", kid, "nps-purpose": "session-issue" });
  const payloadB64 = b64u(payload);
  const signingInput = Buffer.from(`${protectedHeader}.${payloadB64}`, "ascii");
  const sig = edSign(null, signingInput, (keys as unknown as { privateKey: import("node:crypto").KeyObject }).privateKey);
  return { protected: protectedHeader, payload: payloadB64, signature: sig.toString("base64url") };
}

describe("NipGroupJws", () => {
  it("verifies a well-formed group JWS", () => {
    const keys = NipCaKeyPair.generate();
    const jws = makeFlattenedJws(keys, "urn:nps:agent:ca:group-1", { session_pub_key: "ed25519:x", iat: 1 });
    const result = tryVerify(jws, (keys as unknown as { publicKey: import("node:crypto").KeyObject }).publicKey);
    expect(result.ok).toBe(true);
    expect(result.kid).toBe("urn:nps:agent:ca:group-1");
    expect(JSON.parse(result.payloadJson!).session_pub_key).toBe("ed25519:x");
  });

  it("rejects a tampered signature", () => {
    const keys = NipCaKeyPair.generate();
    const other = NipCaKeyPair.generate();
    const jws = makeFlattenedJws(keys, "kid", { a: 1 });
    const result = tryVerify(jws, (other as unknown as { publicKey: import("node:crypto").KeyObject }).publicKey);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NIP-CA-JWS-INVALID");
  });

  it("rejects a bad protected header (wrong purpose)", () => {
    const keys = NipCaKeyPair.generate();
    const b64u = (o: object) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    const protectedHeader = b64u({ alg: "EdDSA", kid: "k", "nps-purpose": "wrong" });
    const payloadB64 = b64u({ a: 1 });
    const sig = edSign(
      null,
      Buffer.from(`${protectedHeader}.${payloadB64}`, "ascii"),
      (keys as unknown as { privateKey: import("node:crypto").KeyObject }).privateKey,
    );
    const jws: FlattenedJws = { protected: protectedHeader, payload: payloadB64, signature: sig.toString("base64url") };
    const result = tryVerify(jws, (keys as unknown as { publicKey: import("node:crypto").KeyObject }).publicKey);
    expect(result.ok).toBe(false);
  });
});

// ── Router (real Request/Response) ────────────────────────────────────────────

describe("NipCaRouter fetch", () => {
  function makeApp(overrides: Partial<NipCaOptions> = {}) {
    const store = new InMemoryNipCaStore();
    const keys = NipCaKeyPair.generate();
    const options: NipCaOptions = {
      caNid: "urn:nps:org:ca.example.com",
      baseUrl: "https://ca.example.com",
      normalizeOcspResponseTime: false,
      ...overrides,
    };
    const ca = new NipCaService(options, store, keys);
    const router = new NipCaRouter(ca, options);
    return { router, ca };
  }

  const base = "https://ca.example.com";

  it("serves discovery", async () => {
    const { router } = makeApp();
    const res = await router.fetch(new Request(`${base}/.well-known/nps-ca`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("urn:nps:org:ca.example.com");
    expect(body.public_key.startsWith("ed25519:")).toBe(true);
    expect(body.capabilities).toContain("ra-tier-1");
  });

  it("registers an agent (201) and verifies (200)", async () => {
    const { router } = makeApp();
    const res = await router.fetch(
      new Request(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "a-1", pub_key: AGENT_PUB, capabilities: ["nwp:query"] }),
      }),
    );
    expect(res.status).toBe(201);
    const frame = await res.json();
    expect(frame.nid).toBe("urn:nps:agent:ca.example.com:a-1");

    const vres = await router.fetch(new Request(`${base}/v1/agents/${encodeURIComponent(frame.nid)}/verify`));
    expect(vres.status).toBe(200);
    expect((await vres.json()).valid).toBe(true);
  });

  it("returns 400 for a malformed register request", async () => {
    const { router } = makeApp();
    const res = await router.fetch(
      new Request(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "a", pub_key: "not-ed25519" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe("NIP-CA-BAD-REQUEST");
  });

  it("returns 409 on duplicate registration", async () => {
    const { router } = makeApp();
    const body = JSON.stringify({ identifier: "dup", pub_key: AGENT_PUB });
    const mk = () =>
      new Request(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await router.fetch(mk())).status).toBe(201);
    expect((await router.fetch(mk())).status).toBe(409);
  });

  it("requires the operator bearer token when configured", async () => {
    const { router } = makeApp({ operatorApiKey: "secret" });
    const noAuth = await router.fetch(
      new Request(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "a", pub_key: AGENT_PUB }),
      }),
    );
    expect(noAuth.status).toBe(401);

    const withAuth = await router.fetch(
      new Request(`${base}/v1/agents/register`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ identifier: "a2", pub_key: AGENT_PUB }),
      }),
    );
    expect(withAuth.status).toBe(201);
  });

  it("registers a group and issues a session via operator body", async () => {
    const { router } = makeApp();
    const gres = await router.fetch(
      new Request(`${base}/v1/orchestrators/groups/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "group-r1", pub_key: AGENT_PUB, capabilities: ["a"] }),
      }),
    );
    expect(gres.status).toBe(201);
    const group = await gres.json();

    const sres = await router.fetch(
      new Request(`${base}/v1/orchestrators/groups/${encodeURIComponent(group.nid)}/sessions/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_pub_key: NipCaKeyPair.generate().publicKeyString() }),
      }),
    );
    expect(sres.status).toBe(201);
    const session = await sres.json();
    expect(session.lineage.parent_nid).toBe(group.nid);

    const listRes = await router.fetch(
      new Request(`${base}/v1/orchestrators/groups/${encodeURIComponent(group.nid)}/sessions`),
    );
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).count).toBe(1);
  });

  it("serves a signed CRL after a revocation", async () => {
    const { router, ca } = makeApp();
    const f = await ca.register("agent", "crl-1", AGENT_PUB, [], "{}");
    await ca.revoke(f.nid, "superseded");
    const res = await router.fetch(new Request(`${base}/v1/crl`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].nid).toBe(f.nid);
    expect(body.signature.startsWith("ed25519:")).toBe(true);
  });

  it("serves an authenticated, ordered certificate inventory", async () => {
    const { router, ca } = makeApp({ operatorApiKey: "secret" });
    const frame = await ca.register(
      "agent", "audit-1", AGENT_PUB, ["nwp:query"], '{"nodes":["*"]}');
    const denied = await router.fetch(
      new Request(`${base}/v1/certificates`));
    expect(denied.status).toBe(401);

    const response = await router.fetch(new Request(
      `${base}/v1/certificates`,
      { headers: { authorization: "Bearer secret" } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].nid).toBe(frame.nid);
    expect(body.entries[0].scope).toEqual({ nodes: ["*"] });
  });
});
