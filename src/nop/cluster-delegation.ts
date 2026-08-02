// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS-CR-0009 §3.4 — NOP delegation re-resolution against a multi-Anchor cluster.
 *
 * `DelegateFrame.target_cluster_anchor` MUST resolve to the cluster's **current active**
 * Anchor (highest `cluster_epoch`, NDP §9). On an `anchor_failover`, in-flight delegations
 * MUST re-resolve to `successor_nid` before retry.
 *
 * The NDP lookup is an injected delegate, so NOP carries no NDP dependency; the composition
 * root adapts `AnnounceFrame → { activeNid: frame.nid, clusterEpoch: frame.cluster_epoch ?? 1 }`.
 */

import type { DelegateFrame } from "./frames.js";

/**
 * SSRF guard for `DelegateFrame.target_cluster_anchor` (NPS-CR-0009 §1.5): it MUST be an NPS
 * NID, never a raw URL a delegation could be pointed at.
 */
export function isNpsNid(value: string): boolean {
  return value.startsWith("urn:nps:");
}

/** The current active Anchor of one cluster, and the epoch it owns it under. */
export interface ClusterAnchorInfo {
  activeNid: string;
  /** uint64. */
  clusterEpoch: number;
}

/** Injected NDP lookup. Returning `undefined` means "the cluster has no live members". */
export type ResolveClusterFn =
  (clusterAnchor: string) => ClusterAnchorInfo | undefined | Promise<ClusterAnchorInfo | undefined>;

/**
 * Caches the active Anchor per cluster and keeps that cache **monotonic per cluster**: an
 * `anchor_failover` at an epoch `<=` the cached one is stale and ignored (**equal is stale**,
 * not idempotent-accept). The cache is invalidated only by a strictly-newer failover or an
 * explicit {@link invalidate}; no TTL is modelled.
 *
 * JavaScript is single-threaded per event loop, so `Map` reads and writes are already atomic
 * with respect to each other; the compare-then-set below is therefore indivisible without a
 * lock. Ports on genuinely concurrent runtimes need a per-cluster lock or a CAS loop.
 */
export class ClusterDelegationResolver {
  /** Cluster NID → active Anchor. Keys compare ordinally. */
  private readonly active = new Map<string, ClusterAnchorInfo>();

  constructor(private readonly resolveClusterFn: ResolveClusterFn) {
    if (typeof resolveClusterFn !== "function") {
      throw new TypeError("ClusterDelegationResolver requires a resolveCluster delegate.");
    }
  }

  /**
   * The NID a DelegateFrame should actually be dispatched to.
   *
   * With no `target_cluster_anchor` this returns `target_agent_nid` and performs **no NDP
   * lookup at all**. `undefined` means "cannot resolve" — the **caller** decides retry vs
   * fail; this never throws for that.
   */
  async resolveDelegateTarget(frame: DelegateFrame): Promise<string | undefined> {
    if (frame === null || frame === undefined) throw new TypeError("frame is required");
    const cluster = frame.targetClusterAnchor;
    if (cluster === undefined || cluster === null || cluster === "") {
      return frame.agentNid;
    }
    // SSRF guard (NPS-CR-0009 §1.5): a cluster target MUST be a `urn:nps:...` NID, never a
    // raw URL. An unresolvable target is reported as "cannot resolve", not dispatched.
    if (!isNpsNid(cluster)) return undefined;
    return (await this.resolveActive(cluster))?.activeNid;
  }

  /** Cached active Anchor for a cluster, resolving through NDP on a miss. */
  async resolveActive(clusterAnchor: string): Promise<ClusterAnchorInfo | undefined> {
    if (!clusterAnchor) throw new TypeError("clusterAnchor must be a non-empty NID.");
    const cached = this.active.get(clusterAnchor);
    if (cached !== undefined) return cached;             // cache hit: NO NDP lookup

    const fresh = await this.resolveClusterFn(clusterAnchor);
    // Negative results are deliberately NOT cached.
    if (fresh !== undefined && fresh !== null) this.active.set(clusterAnchor, fresh);
    return fresh ?? undefined;
  }

  /**
   * Apply an observed `anchor_failover`. Returns true when the cache moved, false when the
   * event was stale. **Equal epoch is stale.** A cluster observed for the first time is
   * accepted unconditionally.
   */
  onAnchorFailover(clusterAnchor: string, successorNid: string, clusterEpoch: number): boolean {
    if (!clusterAnchor) throw new TypeError("clusterAnchor must be a non-empty NID.");
    if (!successorNid) throw new TypeError("successorNid must be a non-empty NID.");

    const current = this.active.get(clusterAnchor);
    if (current !== undefined && clusterEpoch <= current.clusterEpoch) return false;
    this.active.set(clusterAnchor, { activeNid: successorNid, clusterEpoch });
    return true;
  }

  /**
   * Drop the cached entry. The documented recovery path after a dispatch is rejected with
   * `NWP-ANCHOR-NOT-LEADER`: invalidate, take a fresh NDP lookup, retry.
   */
  invalidate(clusterAnchor: string): void {
    this.active.delete(clusterAnchor);
  }

  /** Snapshot of the cache — for diagnostics and tests. */
  get cached(): ReadonlyMap<string, ClusterAnchorInfo> {
    return this.active;
  }
}
