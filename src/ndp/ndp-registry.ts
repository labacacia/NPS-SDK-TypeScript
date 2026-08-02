// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { AnnounceFrame, NdpResolveResult } from "./frames.js";
import { resolveCluster } from "./cluster.js";
import {
  extractHostFromTarget,
  parseNpsTxtRecord,
  SystemDnsTxtLookup,
  type DnsTxtLookup,
} from "./dns-txt.js";

interface RegistryEntry {
  frame:     AnnounceFrame;
  expiresAt: number;
}

export class InMemoryNdpRegistry {
  private readonly _store = new Map<string, RegistryEntry>();

  // Replaceable for testing
  clock: () => number = () => Date.now();

  announce(frame: AnnounceFrame): void {
    const expiresAt = this.clock() + frame.ttl * 1000;
    if (frame.ttl === 0) {
      this._store.delete(frame.nid);
      return;
    }
    this._store.set(frame.nid, { frame, expiresAt });
  }

  getByNid(nid: string): AnnounceFrame | undefined {
    const entry = this._store.get(nid);
    if (entry === undefined) return undefined;
    if (this.clock() > entry.expiresAt) {
      this._store.delete(nid);
      return undefined;
    }
    return entry.frame;
  }

  resolve(target: string): NdpResolveResult | undefined {
    for (const [nid, entry] of this._store) {
      if (this.clock() > entry.expiresAt) { this._store.delete(nid); continue; }
      if (!InMemoryNdpRegistry.nwpTargetMatchesNid(nid, target)) continue;
      const addr = entry.frame.addresses[0];
      if (addr === undefined) continue;
      return { host: addr.host, port: addr.port, ttl: entry.frame.ttl };
    }
    return undefined;
  }

  getAll(): AnnounceFrame[] {
    const now    = this.clock();
    const result: AnnounceFrame[] = [];
    for (const [nid, entry] of this._store) {
      if (now > entry.expiresAt) { this._store.delete(nid); continue; }
      result.push(entry.frame);
    }
    return result;
  }

  /**
   * NPS-CR-0009 — resolve a `cluster_anchor` NID to its current active Anchor: the live
   * member with the highest `cluster_epoch`. `undefined` when the cluster is empty; throws
   * {@link NdpClusterSplitError} on an equal-epoch split-brain. Liveness comes from
   * {@link getAll}, which lazily purges TTL-expired entries (and an announce with `ttl == 0`
   * evicts immediately), so an orderly shutdown removes that Anchor from the election.
   */
  resolveCluster(clusterAnchor: string): AnnounceFrame | undefined {
    return resolveCluster(this, clusterAnchor);
  }

  async resolveWithDns(
    target: string,
    resolver: DnsTxtLookup = new SystemDnsTxtLookup(),
  ): Promise<NdpResolveResult | undefined> {
    // 1. Try in-memory registry first
    const cached = this.resolve(target);
    if (cached !== undefined) return cached;

    // 2. Extract hostname and fall back to DNS TXT lookup
    const host = extractHostFromTarget(target);
    if (host === undefined) return undefined;

    const txtHost = `_nps-node.${host}`;
    let records: string[][];
    try {
      records = await resolver.resolveTxt(txtHost);
    } catch {
      return undefined;
    }

    for (const record of records) {
      const result = parseNpsTxtRecord(record, host);
      if (result !== undefined) return result;
    }

    return undefined;
  }

  static nwpTargetMatchesNid(nid: string, target: string): boolean {
    // NID: urn:nps:node:{authority}:{path-segment}
    // target: nwp://{authority}/{path}
    const nidParts = nid.split(":");
    if (nidParts.length < 5 || nidParts[0] !== "urn" || nidParts[1] !== "nps" || nidParts[2] !== "node") {
      return false;
    }
    if (!target.startsWith("nwp://")) return false;

    const nidAuthority = nidParts[3]!;
    const nidPath      = nidParts[4]!;
    const rest         = target.slice("nwp://".length);
    const slashIdx     = rest.indexOf("/");
    if (slashIdx === -1) return false;

    const urlAuthority = rest.slice(0, slashIdx);
    const urlPath      = rest.slice(slashIdx + 1); // without leading slash

    if (urlAuthority !== nidAuthority) return false;

    // nidPath must be a prefix of urlPath at a segment boundary
    if (urlPath === nidPath) return true;
    if (urlPath.startsWith(nidPath + "/")) return true;
    return false;
  }
}
