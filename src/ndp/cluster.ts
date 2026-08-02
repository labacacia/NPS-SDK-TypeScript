// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS-CR-0009 — highest-epoch cluster resolution (NDP §9).
 *
 * The rule is written **once**, as a free function over a live-announcement list, so that
 * every registry implementation gets identical behaviour rather than reimplementing it.
 * `InMemoryNdpRegistry.resolveCluster()` is a thin delegation to {@link resolveClusterFrom}.
 */

import type { AnnounceFrame } from "./frames.js";
import { NDP_CLUSTER_SPLIT } from "./ndp-error-codes.js";

/**
 * Thrown when a cluster has more than one live Anchor at the top `cluster_epoch`
 * (split-brain). The Registry MUST NOT pick one arbitrarily.
 */
export class NdpClusterSplitError extends Error {
  readonly errorCode = NDP_CLUSTER_SPLIT;
  readonly npsStatus = "NPS-CLIENT-CONFLICT";

  constructor(
    public readonly clusterAnchor: string,
    public readonly epoch: number,
  ) {
    super(`${NDP_CLUSTER_SPLIT}: cluster '${clusterAnchor}' has multiple live active Anchors at epoch ${epoch}.`);
    this.name = "NdpClusterSplitError";
  }
}

/** Minimal registry surface {@link resolveCluster} needs — any registry satisfies it. */
export interface NdpClusterMemberSource {
  /** Live announcements only; expired entries MUST already have been purged. */
  getAll(): AnnounceFrame[];
}

/**
 * Resolves a cluster-anchor NID to its current **active** Anchor announcement: the live
 * member with the highest `cluster_epoch` (absent ⇒ 1, coerced at comparison time only).
 *
 * - Returns `undefined` when the cluster has no live members — that is **not** an error.
 * - Throws {@link NdpClusterSplitError} when more than one live member sits at the top epoch.
 *   Two live members that both *omit* `cluster_epoch` therefore split-brain, since both
 *   coerce to 1 and tie. That is a real consequence, not a case to special-case away.
 * - No role filtering: any live entry whose `cluster_anchor` matches participates.
 * - No tiebreak: the single leader is returned only when exactly one exists.
 */
export function resolveClusterFrom(
  liveMembers: readonly AnnounceFrame[],
  clusterAnchor: string,
): AnnounceFrame | undefined {
  if (!clusterAnchor) {
    throw new Error("clusterAnchor must be a non-empty NID.");
  }
  const members = liveMembers.filter((f) => f.cluster_anchor === clusterAnchor);
  if (members.length === 0) return undefined;

  let top = 1;
  for (const f of members) {
    const epoch = f.cluster_epoch ?? 1;
    if (epoch > top) top = epoch;
  }
  const leaders = members.filter((f) => (f.cluster_epoch ?? 1) === top);
  if (leaders.length > 1) throw new NdpClusterSplitError(clusterAnchor, top);
  return leaders[0];
}

/** {@link resolveClusterFrom} over any registry exposing `getAll()` (live entries only). */
export function resolveCluster(
  registry: NdpClusterMemberSource,
  clusterAnchor: string,
): AnnounceFrame | undefined {
  return resolveClusterFrom(registry.getAll(), clusterAnchor);
}
