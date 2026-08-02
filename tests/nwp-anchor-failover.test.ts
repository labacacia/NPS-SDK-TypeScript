// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NPS-CR-0009 — NWP topology: the `anchor_failover` / `anchor_quorum_lost` anchor_state
// sub-types, `cluster_epoch` on TopologySnapshot, and the epoch fence + leader check.
// Ports tests/NPS.Tests/Nwp/NwpAnchorFailoverTests.cs and brief A §5.6 (which has no
// .NET counterpart — the fence is spec-only).

import { describe, expect, it } from "vitest";
import {
  AnchorFailoverReason,
  AnchorStateField,
  anchorFailoverEvent,
  anchorQuorumLostEvent,
  type AnchorFailoverDetails,
  type AnchorQuorumLostDetails,
  type TopologyEvent,
  type TopologySnapshot,
} from "../src/nwp/anchor-client.js";
import { AnchorEpochFence } from "../src/nwp/anchor-epoch.js";
import {
  AnchorNodeApp,
  InMemoryAnchorTopologyService,
  TopologyProtocolError,
} from "../src/nwp/anchor-server.js";
import {
  NWP_ANCHOR_EPOCH_FENCED,
  NWP_ANCHOR_NOT_LEADER,
  NWP_ERROR_TO_NPS_STATUS,
} from "../src/nwp/nwp-error-codes.js";

// ── anchor_state sub-type wire shapes ─────────────────────────────────────────

describe("anchor_state sub-types (NPS-CR-0009)", () => {
  it("failover event carries successor_nid / cluster_epoch / reason", () => {
    const ev = anchorFailoverEvent("urn:nps:node:x:anchor-b", 3, AnchorFailoverReason.ACTIVE_LOST);
    expect(ev.kind).toBe("anchor_state");
    expect(ev.field).toBe("anchor_failover");
    const d = ev.details as AnchorFailoverDetails;
    expect(d.successor_nid).toBe("urn:nps:node:x:anchor-b");
    expect(d.cluster_epoch).toBe(3);
    expect(d.reason).toBe("active_lost");
    // exactly these three wire keys, nothing else
    expect(Object.keys(d).sort()).toEqual(["cluster_epoch", "reason", "successor_nid"]);
  });

  it("failover reason defaults to planned", () => {
    const ev = anchorFailoverEvent("urn:nps:node:x:anchor-b", 2);
    expect((ev.details as AnchorFailoverDetails).reason).toBe("planned");
  });

  it("quorum-lost event carries quorum_size / available", () => {
    const ev = anchorQuorumLostEvent(3, 1);
    expect(ev.field).toBe("anchor_quorum_lost");
    const d = ev.details as AnchorQuorumLostDetails;
    expect(d.quorum_size).toBe(3);
    expect(d.available).toBe(1);
    expect(Object.keys(d).sort()).toEqual(["available", "quorum_size"]);
  });

  it("exposes the sub-type tags as constants on the anchor_state type, not the shared wire bag", () => {
    expect(AnchorStateField.VERSION_REBASED).toBe("version_rebased");
    expect(AnchorStateField.ANCHOR_FAILOVER).toBe("anchor_failover");
    expect(AnchorStateField.ANCHOR_QUORUM_LOST).toBe("anchor_quorum_lost");
  });

  it("round-trips through the full topology.stream envelope", async () => {
    const events: TopologyEvent[] = [
      anchorFailoverEvent("urn:nps:node:x:anchor-b", 3, "active_lost", 12),
      anchorQuorumLostEvent(3, 1, 13),
    ];
    const app = new AnchorNodeApp(
      { nodeId: "urn:nps:node:x:anchor-a", pathPrefix: "/anchor", actions: {}, requireAuth: false },
      { topologyService: new InMemoryAnchorTopologyService("urn:nps:node:x:anchor-a", [], 1, events) },
    );
    const res = await app.fetch(new Request("http://a/anchor/subscribe", {
      method: "POST",
      body: JSON.stringify({ type: "topology.stream", action: "subscribe", stream_id: "s1", topology: {} }),
    }));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    // [0] is the subscription ack
    expect(lines[1]["event_type"]).toBe("anchor_state");
    expect(lines[1]["payload"]).toEqual({
      field: "anchor_failover",
      details: { successor_nid: "urn:nps:node:x:anchor-b", cluster_epoch: 3, reason: "active_lost" },
    });
    expect(lines[2]["payload"]).toEqual({
      field: "anchor_quorum_lost",
      details: { quorum_size: 3, available: 1 },
    });
  });
});

// ── TopologySnapshot.cluster_epoch ────────────────────────────────────────────

describe("TopologySnapshot.cluster_epoch", () => {
  it("is optional on the type and absent means 1", () => {
    const snap: TopologySnapshot = { version: 1, anchor_nid: "a", cluster_size: 0, members: [] };
    expect(snap.cluster_epoch).toBeUndefined();
    expect(snap.cluster_epoch ?? 1).toBe(1);
  });
});

// ── Epoch fence + leader check (brief A §3.2 / §5.6) ──────────────────────────

const NID_A = "urn:nps:node:x:anchor-a";
const NID_B = "urn:nps:node:x:anchor-b";

function fence(opts: Partial<ConstructorParameters<typeof AnchorEpochFence>[0]> = {}) {
  const emitted: TopologyEvent[] = [];
  let closed = 0;
  const f = new AnchorEpochFence({
    anchorNid: NID_A,
    emit: (e) => emitted.push(e),
    closeStreams: () => { closed++; },
    ...opts,
  });
  return { f, emitted, closed: () => closed };
}

describe("AnchorEpochFence (NPS-CR-0009 §3.2)", () => {
  it("starts ACTIVE at epoch 1 — a single-Anchor cluster is always its own leader", () => {
    const { f } = fence();
    expect(f.ownEpoch).toBe(1);
    expect(f.role).toBe("active");
    expect(f.degraded).toBe(false);
    expect(f.isActive).toBe(true);
  });

  it("fences a strictly-greater inbound epoch with NWP-ANCHOR-EPOCH-FENCED", () => {
    const { f, emitted, closed } = fence({ ownEpoch: 2 });
    let thrown: unknown;
    try { f.onInboundFrame({ cluster_epoch: 5, sender_anchor_nid: NID_B }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(TopologyProtocolError);
    const err = thrown as TopologyProtocolError;
    expect(err.nwpErrorCode).toBe(NWP_ANCHOR_EPOCH_FENCED);
    expect(err.npsStatus).toBe("NPS-CLIENT-CONFLICT");
    expect(NWP_ERROR_TO_NPS_STATUS[NWP_ANCHOR_EPOCH_FENCED]).toBe("NPS-CLIENT-CONFLICT");
    // becomes a standby, emits a TERMINAL anchor_failover, then closes its streams
    expect(f.role).toBe("standby");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      field: "anchor_failover",
      details: { successor_nid: NID_B, cluster_epoch: 5, reason: "active_lost" },
    });
    expect(closed()).toBe(1);
  });

  it("does NOT fence an equal or lower inbound epoch (the deliberate asymmetry with NDP resolve)", () => {
    const { f, emitted } = fence({ ownEpoch: 3 });
    expect(() => f.onInboundFrame({ cluster_epoch: 3 })).not.toThrow();
    expect(() => f.onInboundFrame({ cluster_epoch: 1 })).not.toThrow();
    expect(() => f.onInboundFrame({})).not.toThrow();          // absent ⇒ 1
    expect(() => f.onInboundFrame(undefined)).not.toThrow();
    expect(f.role).toBe("active");
    expect(emitted).toHaveLength(0);
  });

  it("rejects a topology write on a standby with NWP-ANCHOR-NOT-LEADER", () => {
    const { f } = fence({ role: "standby" });
    let thrown: unknown;
    try { f.onInboundFrame({ cluster_epoch: 1 }, true); } catch (e) { thrown = e; }
    expect((thrown as TopologyProtocolError).nwpErrorCode).toBe(NWP_ANCHOR_NOT_LEADER);
    expect((thrown as TopologyProtocolError).npsStatus).toBe("NPS-CLIENT-CONFLICT");
    expect(NWP_ERROR_TO_NPS_STATUS[NWP_ANCHOR_NOT_LEADER]).toBe("NPS-CLIENT-CONFLICT");
  });

  it("lets a standby serve reads", () => {
    const { f } = fence({ role: "standby" });
    expect(() => f.onInboundFrame({ cluster_epoch: 1 }, false)).not.toThrow();
  });

  it("rejects writes on the ACTIVE owner while read-only-degraded", () => {
    const { f, emitted } = fence();
    const ev = f.onQuorumLost(3, 1);
    expect(ev.field).toBe("anchor_quorum_lost");
    expect(emitted).toContain(ev);
    expect(f.degraded).toBe(true);
    expect(f.role).toBe("active");
    expect(() => f.onInboundFrame({}, true)).toThrow(TopologyProtocolError);
    expect(() => f.onInboundFrame({}, false)).not.toThrow();   // reads still fine
  });

  it("sets the NDP self-announcement health to degraded on quorum loss", () => {
    const seen: string[] = [];
    const f = new AnchorEpochFence({ anchorNid: NID_A, onHealthChange: (h) => seen.push(h) });
    f.onQuorumLost(3, 1);
    f.onQuorumRestored();
    expect(seen).toEqual(["degraded", "healthy"]);
    expect(f.degraded).toBe(false);
  });

  it("stamps every response with the current cluster_epoch", () => {
    const { f } = fence({ ownEpoch: 7 });
    expect(f.stampResponse({ version: 4 })).toEqual({ version: 4, cluster_epoch: 7 });
  });

  it("takeOwnership requires a strictly greater epoch than every epoch ever observed", () => {
    const { f, emitted } = fence({ ownEpoch: 2 });
    expect(() => f.takeOwnership(2)).toThrow(RangeError);
    expect(() => f.takeOwnership(1)).toThrow(RangeError);
    const ev = f.takeOwnership(3, "planned");
    expect(f.ownEpoch).toBe(3);
    expect(f.role).toBe("active");
    expect(ev.details).toEqual({ successor_nid: NID_A, cluster_epoch: 3, reason: "planned" });
    expect(emitted).toHaveLength(1);
  });

  it("remembers a fenced epoch, so a would-be successor cannot reclaim at the same number", () => {
    const { f } = fence({ ownEpoch: 2 });
    expect(() => f.onInboundFrame({ cluster_epoch: 9, sender_anchor_nid: NID_B })).toThrow();
    expect(() => f.takeOwnership(9)).toThrow(RangeError);
    expect(() => f.takeOwnership(10)).not.toThrow();
  });
});

// ── The fence wired into AnchorNodeApp ────────────────────────────────────────

describe("AnchorNodeApp + epoch fence", () => {
  function app(f?: AnchorEpochFence) {
    return new AnchorNodeApp(
      {
        nodeId: NID_A, pathPrefix: "/anchor", requireAuth: false,
        actions: { "topology.set": { description: "mutating", resultAnchor: "r" } },
      },
      {
        topologyService: new InMemoryAnchorTopologyService(NID_A, [], 4),
        invokeHandler: async () => ({ done: true }),
        epochFence: f,
      },
    );
  }

  const snapshotBody = JSON.stringify({ type: "topology.snapshot", topology: { scope: "cluster" } });

  it("stamps cluster_epoch on every topology.snapshot response", async () => {
    const res = await app(new AnchorEpochFence({ anchorNid: NID_A, ownEpoch: 6 }))
      .fetch(new Request("http://a/anchor/query", { method: "POST", body: snapshotBody }));
    expect(res.status).toBe(200);
    const caps = await res.json() as { data: TopologySnapshot[] };
    expect(caps.data[0].cluster_epoch).toBe(6);
  });

  it("stamps cluster_epoch on the topology.stream subscription ack", async () => {
    const res = await app(new AnchorEpochFence({ anchorNid: NID_A, ownEpoch: 6 }))
      .fetch(new Request("http://a/anchor/subscribe", {
        method: "POST",
        body: JSON.stringify({ type: "topology.stream", action: "subscribe", topology: {} }),
      }));
    const ack = JSON.parse((await res.text()).trim().split("\n")[0]);
    expect(ack["cluster_epoch"]).toBe(6);
  });

  it("returns 409 NWP-ANCHOR-EPOCH-FENCED for a higher-epoch inbound frame", async () => {
    const res = await app(new AnchorEpochFence({ anchorNid: NID_A, ownEpoch: 2 }))
      .fetch(new Request("http://a/anchor/query", {
        method: "POST",
        headers: { "X-NWP-Cluster-Epoch": "9", "X-NWP-Anchor-Nid": NID_B },
        body: snapshotBody,
      }));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, string>;
    expect(body["error"]).toBe(NWP_ANCHOR_EPOCH_FENCED);
    expect(body["status"]).toBe("NPS-CLIENT-CONFLICT");
  });

  it("returns 409 NWP-ANCHOR-NOT-LEADER for a write on a standby, while reads still succeed", async () => {
    const standby = new AnchorEpochFence({ anchorNid: NID_A, role: "standby", ownEpoch: 2 });
    const a = app(standby);
    const write = await a.fetch(new Request("http://a/anchor/invoke", {
      method: "POST",
      body: JSON.stringify({ action_id: "topology.set", params: {} }),
    }));
    expect(write.status).toBe(409);
    expect((await write.json() as Record<string, string>)["error"]).toBe(NWP_ANCHOR_NOT_LEADER);

    const read = await a.fetch(new Request("http://a/anchor/query", { method: "POST", body: snapshotBody }));
    expect(read.status).toBe(200);
    // a standby MAY serve stale reads stamped with its last-known epoch
    expect(((await read.json() as { data: TopologySnapshot[] }).data[0]).cluster_epoch).toBe(2);
  });

  it("is a no-op without a fence — a single-Anchor deployment is unaffected", async () => {
    const res = await app().fetch(new Request("http://a/anchor/query", {
      method: "POST", headers: { "X-NWP-Cluster-Epoch": "99" }, body: snapshotBody,
    }));
    expect(res.status).toBe(200);
    expect(((await res.json() as { data: TopologySnapshot[] }).data[0]).cluster_epoch).toBeUndefined();
  });
});
