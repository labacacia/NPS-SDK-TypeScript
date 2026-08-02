// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NPS-CR-0009 §3.4 — NOP delegation re-resolution.
// Port of tests/NPS.Tests/Nop/ClusterDelegationResolverTests.cs (brief A §5.4), plus the
// wiring into this tree's orchestrator (the only real orchestrator in any SDK).

import { describe, expect, it, vi } from "vitest";
import {
  ClusterDelegationResolver,
  isNpsNid,
  type ClusterAnchorInfo,
} from "../src/nop/cluster-delegation.js";
import { DelegateFrame } from "../src/nop/frames.js";
import { NopOrchestrator, type NodeResult } from "../src/nop/orchestrator.js";
import { TaskFrame } from "../src/nop/frames.js";
import { TaskState } from "../src/nop/models.js";
import { NWP_ANCHOR_NOT_LEADER } from "../src/nwp/nwp-error-codes.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLUSTER   = "urn:nps:cluster:x:main";
const ANCHOR_A  = "urn:nps:node:x:anchor-a";
const ANCHOR_B  = "urn:nps:node:x:anchor-b";
const AGENT_NID = "urn:nps:agent:x:w1";

function delegate(targetClusterAnchor?: string): DelegateFrame {
  return new DelegateFrame(
    "t1", "s1", "do", AGENT_NID,
    undefined, undefined, undefined, targetClusterAnchor,
  );
}

// ── Resolver ─────────────────────────────────────────────────────────────────

describe("ClusterDelegationResolver (NPS-CR-0009 §3.4)", () => {
  it("without a cluster target it returns the agent NID and never touches NDP", async () => {
    const lookup = vi.fn((): ClusterAnchorInfo => { throw new Error("NDP must not be consulted"); });
    const r = new ClusterDelegationResolver(lookup);
    expect(await r.resolveDelegateTarget(delegate())).toBe(AGENT_NID);
    expect(await r.resolveDelegateTarget(delegate(""))).toBe(AGENT_NID);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a cluster target resolves to the active anchor and caches it", async () => {
    const lookup = vi.fn(() => ({ activeNid: ANCHOR_A, clusterEpoch: 1 }));
    const r = new ClusterDelegationResolver(lookup);
    expect(await r.resolveDelegateTarget(delegate(CLUSTER))).toBe(ANCHOR_A);
    expect(await r.resolveDelegateTarget(delegate(CLUSTER))).toBe(ANCHOR_A);
    expect(lookup).toHaveBeenCalledTimes(1);          // second call is a cache hit
  });

  it("a failover event redirects subsequent delegations to the successor", async () => {
    const lookup = vi.fn(() => ({ activeNid: ANCHOR_A, clusterEpoch: 1 }));
    const r = new ClusterDelegationResolver(lookup);
    expect(await r.resolveDelegateTarget(delegate(CLUSTER))).toBe(ANCHOR_A);   // warm the cache @1
    expect(r.onAnchorFailover(CLUSTER, ANCHOR_B, 2)).toBe(true);
    expect(await r.resolveDelegateTarget(delegate(CLUSTER))).toBe(ANCHOR_B);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a stale failover event is ignored — EQUAL is stale, not idempotent-accept", async () => {
    const r = new ClusterDelegationResolver(() => ({ activeNid: ANCHOR_B, clusterEpoch: 3 }));
    await r.resolveActive(CLUSTER);                    // cache @3
    expect(r.onAnchorFailover(CLUSTER, "urn:nps:node:x:anchor-c", 3)).toBe(false);
    expect(r.onAnchorFailover(CLUSTER, "urn:nps:node:x:anchor-c", 2)).toBe(false);
    expect((await r.resolveActive(CLUSTER))!.activeNid).toBe(ANCHOR_B);
  });

  it("accepts a first observation unconditionally", () => {
    const r = new ClusterDelegationResolver(() => undefined);
    expect(r.onAnchorFailover(CLUSTER, ANCHOR_B, 1)).toBe(true);
    expect(r.cached.get(CLUSTER)).toEqual({ activeNid: ANCHOR_B, clusterEpoch: 1 });
  });

  it("invalidate forces a fresh lookup", async () => {
    const queue: ClusterAnchorInfo[] = [
      { activeNid: ANCHOR_A, clusterEpoch: 1 },
      { activeNid: ANCHOR_B, clusterEpoch: 2 },
    ];
    const r = new ClusterDelegationResolver(() => queue.shift());
    expect((await r.resolveActive(CLUSTER))!.activeNid).toBe(ANCHOR_A);
    r.invalidate(CLUSTER);
    expect((await r.resolveActive(CLUSTER))!.activeNid).toBe(ANCHOR_B);
  });

  it("does NOT cache a negative result", async () => {
    const lookup = vi.fn((): ClusterAnchorInfo | undefined => undefined);
    const r = new ClusterDelegationResolver(lookup);
    expect(await r.resolveActive(CLUSTER)).toBeUndefined();
    expect(await r.resolveActive(CLUSTER)).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.cached.size).toBe(0);
  });

  it("returns undefined — never throws — when a cluster cannot be resolved", async () => {
    const r = new ClusterDelegationResolver(() => undefined);
    expect(await r.resolveDelegateTarget(delegate(CLUSTER))).toBeUndefined();
  });

  it("refuses a non-NID cluster target (SSRF guard)", async () => {
    const lookup = vi.fn((): ClusterAnchorInfo => { throw new Error("must not be reached"); });
    const r = new ClusterDelegationResolver(lookup);
    expect(await r.resolveDelegateTarget(delegate("http://evil.example/internal"))).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(isNpsNid(CLUSTER)).toBe(true);
    expect(isNpsNid("http://evil.example/")).toBe(false);
  });

  it("validates its arguments", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new ClusterDelegationResolver(undefined as any)).toThrow(TypeError);
    const r = new ClusterDelegationResolver(() => undefined);
    expect(() => r.onAnchorFailover("", ANCHOR_B, 1)).toThrow(TypeError);
    expect(() => r.onAnchorFailover(CLUSTER, "", 1)).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(r.resolveDelegateTarget(null as any)).rejects.toThrow(TypeError);
    await expect(r.resolveActive("")).rejects.toThrow(TypeError);
  });

  it("adapts an AnnounceFrame the way a composition root would", async () => {
    // The composition root maps AnnounceFrame → ClusterAnchorInfo(nid, cluster_epoch ?? 1).
    const announce = { nid: ANCHOR_A, cluster_epoch: undefined as number | undefined };
    const r = new ClusterDelegationResolver(() => ({
      activeNid: announce.nid, clusterEpoch: announce.cluster_epoch ?? 1,
    }));
    expect(await r.resolveActive(CLUSTER)).toEqual({ activeNid: ANCHOR_A, clusterEpoch: 1 });
  });
});

// ── Orchestrator wiring ──────────────────────────────────────────────────────

describe("NopOrchestrator + ClusterDelegationResolver", () => {
  function task(targetClusterAnchor?: string): TaskFrame {
    return new TaskFrame("task-1", {
      nodes: [{ id: "n1", action: "do", agent: AGENT_NID, targetClusterAnchor }],
      edges: [],
    });
  }

  it("dispatches cluster-targeted nodes to the resolved active Anchor", async () => {
    const seen: (string | undefined)[] = [];
    const orchestrator = new NopOrchestrator(
      { dispatch: async (nodeId, _n, _p, _d, targetNid) => { seen.push(targetNid); return { nodeId, ok: true, output: 1 }; } },
      undefined,
      { clusterResolver: new ClusterDelegationResolver(() => ({ activeNid: ANCHOR_A, clusterEpoch: 1 })) },
    );
    const result = await orchestrator.execute(task(CLUSTER));
    expect(result.state).toBe(TaskState.COMPLETED);
    expect(seen).toEqual([ANCHOR_A]);
  });

  it("falls back to node.agent with no cluster target, and with no resolver configured", async () => {
    const seen: (string | undefined)[] = [];
    const dispatcher = { dispatch: async (nodeId: string, _n: unknown, _p: unknown, _d: number, t?: string) => {
      seen.push(t); return { nodeId, ok: true } as NodeResult;
    } };
    await new NopOrchestrator(dispatcher, undefined,
      { clusterResolver: new ClusterDelegationResolver(() => ({ activeNid: ANCHOR_A, clusterEpoch: 1 })) },
    ).execute(task());
    await new NopOrchestrator(dispatcher).execute(task(CLUSTER));
    expect(seen).toEqual([AGENT_NID, AGENT_NID]);
  });

  it("re-resolves after an observed anchor_failover", async () => {
    const seen: (string | undefined)[] = [];
    const resolver = new ClusterDelegationResolver(() => ({ activeNid: ANCHOR_A, clusterEpoch: 1 }));
    const dispatcher = { dispatch: async (nodeId: string, _n: unknown, _p: unknown, _d: number, t?: string) => {
      seen.push(t); return { nodeId, ok: true } as NodeResult;
    } };
    const orchestrator = new NopOrchestrator(dispatcher, undefined, { clusterResolver: resolver });

    await orchestrator.execute(task(CLUSTER));
    expect(orchestrator.onAnchorFailover(CLUSTER, ANCHOR_B, 2)).toBe(true);
    expect(orchestrator.onAnchorFailover(CLUSTER, ANCHOR_A, 2)).toBe(false);   // stale
    await new NopOrchestrator(dispatcher, undefined, { clusterResolver: resolver }).execute(task(CLUSTER));
    expect(seen).toEqual([ANCHOR_A, ANCHOR_B]);
  });

  it("invalidates the cache and re-resolves after NWP-ANCHOR-NOT-LEADER", async () => {
    const queue: ClusterAnchorInfo[] = [
      { activeNid: ANCHOR_A, clusterEpoch: 1 },
      { activeNid: ANCHOR_B, clusterEpoch: 2 },
    ];
    const resolver = new ClusterDelegationResolver(() => queue.shift());
    const seen: (string | undefined)[] = [];
    const orchestrator = new NopOrchestrator(
      {
        dispatch: async (nodeId, _n, _p, _d, targetNid) => {
          seen.push(targetNid);
          return targetNid === ANCHOR_A
            ? { nodeId, ok: false, error: { code: NWP_ANCHOR_NOT_LEADER, message: "standby" } }
            : { nodeId, ok: true, output: "ok" };
        },
      },
      undefined,
      { clusterResolver: resolver },
    );
    const result = await orchestrator.execute({
      ...task(CLUSTER),
      dag: { nodes: [{ id: "n1", action: "do", agent: AGENT_NID, targetClusterAnchor: CLUSTER,
        retryPolicy: { maxRetries: 1, backoff: "fixed" as never, baseDelayMs: 1 } }], edges: [] },
    } as TaskFrame);
    expect(seen).toEqual([ANCHOR_A, ANCHOR_B]);
    expect(result.state).toBe(TaskState.COMPLETED);
  });

  it("onAnchorFailover is a safe no-op when no resolver is configured", () => {
    expect(new NopOrchestrator({ dispatch: async (nodeId) => ({ nodeId, ok: true }) })
      .onAnchorFailover(CLUSTER, ANCHOR_B, 2)).toBe(false);
  });
});
