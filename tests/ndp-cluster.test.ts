// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NPS-CR-0009 — NDP `cluster_epoch` wire field, highest-epoch cluster resolution and the
// equal-epoch split-brain fault. Port of tests/NPS.Tests/Ndp/NdpClusterResolutionTests.cs
// plus the signature canonical-form regressions of brief A §5.5.

import { describe, expect, it } from "vitest";
import { AnnounceFrame } from "../src/ndp/frames.js";
import { InMemoryNdpRegistry } from "../src/ndp/ndp-registry.js";
import { NdpClusterSplitError, resolveClusterFrom } from "../src/ndp/cluster.js";
import { NDP_CLUSTER_SPLIT, NDP_ERROR_TO_NPS_STATUS } from "../src/ndp/ndp-error-codes.js";

// ── Fixture (mirrors NdpClusterResolutionTests) ───────────────────────────────

const CLUSTER = "urn:nps:cluster:api.test:main";
const ADDRS = [{ host: "10.0.0.1", port: 17433, protocol: "nwp" }];

function anchor(name: string, clusterEpoch?: number, ttl = 3600): AnnounceFrame {
  return new AnnounceFrame(
    `urn:nps:node:api.test:${name}`,
    ADDRS,
    ["topology.read"],
    ttl,
    "2026-07-05T00:00:00Z",
    "ed25519:placeholder",
    "anchor",           // node_type
    ["anchor"],         // node_roles
    CLUSTER,            // cluster_anchor
    undefined, undefined, undefined, undefined,
    60_000,
    undefined, undefined,
    clusterEpoch,
  );
}

function registryWith(...frames: AnnounceFrame[]): InMemoryNdpRegistry {
  const reg = new InMemoryNdpRegistry();
  for (const f of frames) reg.announce(f);
  return reg;
}

// ── Wire field ────────────────────────────────────────────────────────────────

describe("AnnounceFrame.cluster_epoch (NPS-CR-0009)", () => {
  it("round-trips through toDict / fromDict", () => {
    const back = AnnounceFrame.fromDict(anchor("anchor-a", 7).toDict());
    expect(back.cluster_epoch).toBe(7);
    expect(back.effectiveClusterEpoch).toBe(7);
  });

  it("is omitted entirely — never null or 0 — when unset", () => {
    const d = anchor("anchor-a").toDict();
    expect("cluster_epoch" in d).toBe(false);
    expect(anchor("anchor-a").unsignedDict()).not.toHaveProperty("cluster_epoch");
  });

  it("absent reads as 1 at comparison time while the stored frame keeps undefined", () => {
    const f = anchor("anchor-a");
    expect(f.cluster_epoch).toBeUndefined();
    expect(f.effectiveClusterEpoch).toBe(1);
  });
});

// ── CR-0010 bridge_inbound_protocols ─────────────────────────────────────────

describe("AnnounceFrame.bridge_inbound_protocols (NPS-CR-0010)", () => {
  function bridge(inbound?: string[], outbound?: string[]): AnnounceFrame {
    return new AnnounceFrame(
      "urn:nps:node:api.test:bridge-1", ADDRS, ["nwp:query"], 3600,
      "2026-07-05T00:00:00Z", "ed25519:placeholder",
      "bridge", ["bridge"], undefined, undefined, outbound, undefined, undefined,
      60_000, undefined, undefined, undefined, inbound,
    );
  }

  it("round-trips through toDict / fromDict", () => {
    const back = AnnounceFrame.fromDict(bridge(["mcp", "a2a"], ["http"]).toDict());
    expect(back.bridge_inbound_protocols).toEqual(["mcp", "a2a"]);
    expect(back.bridge_protocols).toEqual(["http"]);
  });

  it("is omitted entirely — never null — when unset", () => {
    const d = bridge(undefined, ["http"]).toDict();
    expect("bridge_inbound_protocols" in d).toBe(false);
    // receivers MUST treat an absent set as [] — a pre-alpha.16 outbound-only Bridge Node
    expect(AnnounceFrame.fromDict(d).bridge_inbound_protocols ?? []).toEqual([]);
  });

  it("is independent of bridge_protocols — a protocol MAY appear in both", () => {
    const d = bridge(["mcp", "http"], ["http", "grpc"]).toDict();
    expect(d["bridge_inbound_protocols"]).toEqual(["mcp", "http"]);
    expect(d["bridge_protocols"]).toEqual(["http", "grpc"]);
  });

  it("an explicitly empty inbound set is emitted (it is a declaration, not an omission)", () => {
    expect(bridge([], ["http"]).toDict()["bridge_inbound_protocols"]).toEqual([]);
  });
});

// ── Signature canonical-form regression (brief A §5.5) ────────────────────────

/** The signing path of `NdpAnnounceValidator` / `NipIdentity.sign`. */
function canonical(f: AnnounceFrame): string {
  const unsigned = f.unsignedDict();
  return JSON.stringify(unsigned, Object.keys(unsigned).sort());
}

describe("AnnounceFrame canonical form (NPS-CR-0009 / NPS-CR-0010)", () => {
  it("cluster_epoch IS inside the signed canonical form", () => {
    expect(canonical(anchor("anchor-a", 3))).toContain('"cluster_epoch":3');
  });

  it("bridge_inbound_protocols IS inside the signed canonical form", () => {
    const f = new AnnounceFrame(
      "urn:nps:node:api.test:bridge", ADDRS, ["nwp:query"], 3600,
      "2026-07-05T00:00:00Z", "ed25519:placeholder",
      "bridge", ["bridge"], undefined, undefined, ["http"], undefined, undefined,
      60_000, undefined, undefined, undefined, ["mcp", "a2a"],
    );
    expect(canonical(f)).toContain('"bridge_inbound_protocols":["mcp","a2a"]');
  });

  it("a frame with no cluster_epoch is byte-identical to the pre-CR-0009 canonical form", () => {
    // Pre-CR-0009 canonical form, reconstructed by hand from the field set that existed
    // before this change. Byte equality here is what keeps already-signed announcements
    // verifying after the upgrade.
    const legacy = {
      nid: "urn:nps:node:api.test:anchor-a",
      addresses: ADDRS,
      capabilities: ["topology.read"],
      ttl: 3600,
      timestamp: "2026-07-05T00:00:00Z",
      heartbeat_interval_ms: 60_000,
      node_type: "anchor",
      node_roles: ["anchor"],
      cluster_anchor: CLUSTER,
    };
    const legacyCanonical = JSON.stringify(legacy, Object.keys(legacy).sort());
    expect(canonical(anchor("anchor-a"))).toBe(legacyCanonical);
  });

  it("the signed body still excludes signature / health / last_seen", () => {
    const f = new AnnounceFrame(
      "urn:nps:node:api.test:anchor-a", ADDRS, ["topology.read"], 3600,
      "2026-07-05T00:00:00Z", "ed25519:sig",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      60_000, "degraded", "2026-07-05T00:01:00Z", 4,
    );
    const c = canonical(f);
    expect(c).not.toContain("signature");
    expect(c).not.toContain("health");
    expect(c).not.toContain("last_seen");
    expect(c).toContain('"cluster_epoch":4');
    // and the wire form does carry them
    const d = f.toDict();
    expect(d["health"]).toBe("degraded");
    expect(d["last_seen"]).toBe("2026-07-05T00:01:00Z");
  });

  it("changing cluster_epoch changes the signed bytes (it is a fenced, authenticated claim)", () => {
    expect(canonical(anchor("anchor-a", 2))).not.toBe(canonical(anchor("anchor-a", 3)));
  });
});

// ── Highest-epoch cluster resolution ──────────────────────────────────────────

describe("resolveCluster (NPS-CR-0009 §9)", () => {
  it("resolves the highest-epoch active anchor", () => {
    const reg = registryWith(anchor("anchor-a", 1), anchor("anchor-b", 3));
    const winner = reg.resolveCluster(CLUSTER);
    expect(winner).toBeDefined();
    expect(winner!.nid).toBe("urn:nps:node:api.test:anchor-b");
    expect(winner!.cluster_epoch).toBe(3);
  });

  it("treats an absent epoch as one", () => {
    const reg = registryWith(anchor("anchor-a"));
    const winner = reg.resolveCluster(CLUSTER);
    expect(winner).toBeDefined();
    expect(winner!.effectiveClusterEpoch).toBe(1);
  });

  it("throws NDP-CLUSTER-SPLIT on a split brain at the top epoch", () => {
    const reg = registryWith(anchor("anchor-a", 2), anchor("anchor-b", 2));
    let thrown: unknown;
    try { reg.resolveCluster(CLUSTER); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(NdpClusterSplitError);
    const err = thrown as NdpClusterSplitError;
    expect(err.errorCode).toBe(NDP_CLUSTER_SPLIT);
    expect(err.epoch).toBe(2);
    expect(err.clusterAnchor).toBe(CLUSTER);
    expect(NDP_ERROR_TO_NPS_STATUS[NDP_CLUSTER_SPLIT]).toBe("NPS-CLIENT-CONFLICT");
  });

  it("two live members that BOTH omit cluster_epoch split-brain (both coerce to 1)", () => {
    const reg = registryWith(anchor("anchor-a"), anchor("anchor-b"));
    expect(() => reg.resolveCluster(CLUSTER)).toThrow(NdpClusterSplitError);
  });

  it("resolves to undefined — not an error — when there are no live members", () => {
    expect(new InMemoryNdpRegistry().resolveCluster(CLUSTER)).toBeUndefined();
  });

  it("ignores members belonging to another cluster", () => {
    const other = new AnnounceFrame(
      "urn:nps:node:api.test:anchor-z", ADDRS, ["topology.read"], 3600,
      "2026-07-05T00:00:00Z", "ed25519:placeholder",
      "anchor", ["anchor"], "urn:nps:cluster:api.test:other",
      undefined, undefined, undefined, undefined, 60_000, undefined, undefined, 99,
    );
    const reg = registryWith(anchor("anchor-a", 2), other);
    expect(reg.resolveCluster(CLUSTER)!.nid).toBe("urn:nps:node:api.test:anchor-a");
  });

  it("excludes a TTL-expired member from the election", () => {
    const reg = new InMemoryNdpRegistry();
    let now = 1_000_000;
    reg.clock = () => now;
    reg.announce(anchor("anchor-a", 1, 3600));
    reg.announce(anchor("anchor-b", 3, 10));       // expires first
    expect(reg.resolveCluster(CLUSTER)!.cluster_epoch).toBe(3);
    now += 11_000;
    expect(reg.resolveCluster(CLUSTER)!.cluster_epoch).toBe(1);
  });

  it("a ttl=0 announce evicts immediately and changes the winner", () => {
    const reg = registryWith(anchor("anchor-a", 1), anchor("anchor-b", 3));
    expect(reg.resolveCluster(CLUSTER)!.cluster_epoch).toBe(3);
    reg.announce(anchor("anchor-b", 3, 0));         // orderly shutdown
    expect(reg.resolveCluster(CLUSTER)!.cluster_epoch).toBe(1);
  });

  it("does not filter by role — any live entry whose cluster_anchor matches participates", () => {
    const nonAnchor = new AnnounceFrame(
      "urn:nps:node:api.test:memory-1", ADDRS, [], 3600,
      "2026-07-05T00:00:00Z", "ed25519:placeholder",
      "memory", ["memory"], CLUSTER,
      undefined, undefined, undefined, undefined, 60_000, undefined, undefined, 5,
    );
    const reg = registryWith(anchor("anchor-a", 2), nonAnchor);
    expect(reg.resolveCluster(CLUSTER)!.nid).toBe("urn:nps:node:api.test:memory-1");
  });

  it("the rule is a free function so any registry shape inherits it", () => {
    const frames = [anchor("anchor-a", 1), anchor("anchor-b", 4)];
    expect(resolveClusterFrom(frames, CLUSTER)!.cluster_epoch).toBe(4);
    expect(() => resolveClusterFrom(frames, "")).toThrow();
  });
});
