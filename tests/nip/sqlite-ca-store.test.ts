// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// SqliteNipCaStore round-trip tests (NPS-3 §8). Uses an in-memory SQLite DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteNipCaStore } from "../../src/nip/ca/sqlite-store.js";
import { NID_ROLE_GROUP, NID_ROLE_SESSION, type NipCertRecord } from "../../src/nip/ca/store.js";

let store: SqliteNipCaStore;

function record(over: Partial<NipCertRecord> = {}): NipCertRecord {
  return {
    nid: "urn:nps:agent:alice",
    entityType: "agent",
    serial: "0x1",
    pubKey: "ed25519:AAAA",
    capabilities: ["read", "write"],
    scopeJson: '{"scope":"all"}',
    issuedBy: "urn:nps:ca:root",
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  store = SqliteNipCaStore.open(":memory:");
});
afterEach(() => {
  store.close();
});

describe("SqliteNipCaStore", () => {
  it("saves and retrieves a record by NID", async () => {
    const rec = record();
    await store.save(rec);
    const got = await store.getByNid("urn:nps:agent:alice");
    expect(got).not.toBeNull();
    expect(got!.serial).toBe("0x1");
    expect(got!.capabilities).toEqual(["read", "write"]);
    expect(got!.issuedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("retrieves by serial", async () => {
    await store.save(record({ serial: "0xABCD" }));
    const got = await store.getBySerial("0xABCD");
    expect(got!.nid).toBe("urn:nps:agent:alice");
  });

  it("rejects a duplicate serial", async () => {
    await store.save(record({ serial: "0xDUP" }));
    await expect(store.save(record({ nid: "urn:nps:agent:bob", serial: "0xDUP" }))).rejects.toThrow();
  });

  it("generates monotonic hex serials", async () => {
    const s1 = await store.nextSerial();
    const s2 = await store.nextSerial();
    const s3 = await store.nextSerial();
    expect(s1).toBe("0x1");
    expect(s2).toBe("0x2");
    expect(s3).toBe("0x3");
  });

  it("revokes a certificate and lists revoked", async () => {
    await store.save(record());
    const when = new Date("2026-06-01T00:00:00.000Z");
    const ok = await store.revoke("urn:nps:agent:alice", "keyCompromise", when);
    expect(ok).toBe(true);
    const got = await store.getByNid("urn:nps:agent:alice");
    expect(got!.revokedAt!.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(got!.revokeReason).toBe("keyCompromise");
    const revoked = await store.getRevoked();
    expect(revoked).toHaveLength(1);
  });

  it("revoke returns false for unknown NID", async () => {
    const ok = await store.revoke("urn:nps:agent:ghost", "x", new Date());
    expect(ok).toBe(false);
  });

  it("lists all records", async () => {
    await store.save(record({ nid: "a", serial: "0x1" }));
    await store.save(record({ nid: "b", serial: "0x2" }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it("stores and queries lineage (group / session)", async () => {
    await store.save(
      record({ nid: "urn:nps:group:g1", serial: "0xG", nidRole: NID_ROLE_GROUP }),
    );
    await store.save(
      record({
        nid: "urn:nps:session:s1",
        serial: "0xS1",
        nidRole: NID_ROLE_SESSION,
        parentNid: "urn:nps:group:g1",
        lineageJson: '{"parent":"urn:nps:group:g1"}',
      }),
    );
    const sessions = await store.getByParentNid("urn:nps:group:g1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.nid).toBe("urn:nps:session:s1");
    expect(sessions[0]!.nidRole).toBe("session");
    expect(sessions[0]!.lineageJson).toBe('{"parent":"urn:nps:group:g1"}');
  });

  it("preserves optional null fields", async () => {
    await store.save(record());
    const got = await store.getByNid("urn:nps:agent:alice");
    expect(got!.revokedAt).toBeNull();
    expect(got!.metadataJson).toBeNull();
    expect(got!.nidRole).toBeNull();
    expect(got!.parentNid).toBeNull();
  });
});
