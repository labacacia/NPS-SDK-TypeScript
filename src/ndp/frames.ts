// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { EncodingTier, FrameType } from "../core/frames.js";
import type { NpsFrame } from "../core/codec.js";
import { NDP_GRAPH_INVALID, NDP_GRAPH_TOO_LARGE } from "./ndp-error-codes.js";

const MAX_GRAPH_NODES = 256;
const MAX_GRAPH_EDGES = 1024;

export interface NdpAddress {
  host:     string;
  port:     number;
  protocol: string;
}

export interface NdpGraphNode {
  nid:            string;
  cluster_anchor?: string;
  node_roles?:    string[];
}

export interface NdpGraphEdge {
  from_nid:    string;
  to_nid:      string;
  latency_ms?: number;
  protocol?:   string;
}

export interface NdpResolveResult {
  host:              string;
  port:              number;
  ttl:               number;
  certFingerprint?:  string;
}

export class AnnounceFrame implements NpsFrame {
  readonly frameType     = FrameType.ANNOUNCE;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly nid:                  string,
    public readonly addresses:            readonly NdpAddress[],
    public readonly capabilities:         readonly string[],
    public readonly ttl:                  number,
    public readonly timestamp:            string,
    public readonly signature:            string,
    public readonly nodeType?:            string,
    public readonly node_roles?:          string[],
    public readonly cluster_anchor?:      string,
    public readonly spawn_spec_ref?:      string, // opaque ref resolving to a SpawnSpec
    public readonly bridge_protocols?:    string[],
    public readonly activation_mode?:     string,
    public readonly activation_endpoint?: NdpAddress,
    public readonly heartbeat_interval_ms: number = 60_000, // NDP v0.9 §3.1
    // NDP v0.9 liveness — wire-only, EXCLUDED from the signed canonical form
    // (last_seen updates every heartbeat → must not require re-signing; §3.2.1).
    public readonly health?:              string, // "healthy" / "degraded" / "draining"
    public readonly last_seen?:           string, // ISO 8601 UTC liveness beat
    // NPS-CR-0009 — epoch under which this Anchor owns its `cluster_anchor` cluster.
    // uint64, starts at 1, strictly increases on every ownership transfer (a fencing
    // token). Absent ⇒ 1 (single-Anchor); absence is NOT an error. IN the signed body.
    public readonly cluster_epoch?:       number,
    // NPS-CR-0010 — external protocols this Bridge Node serves INBOUND (external → NPS).
    // Independent of `bridge_protocols` (outbound). Absent ⇒ [] (outbound-only Bridge).
    // IN the signed body.
    public readonly bridge_inbound_protocols?: string[],
    // NDP registry monotonic sequence. Absent is allowed only by local-dev profiles; when
    // present it is part of the signed body.
    public readonly graph_seq?:            number,
  ) {}

  unsignedDict(): Record<string, unknown> {
    const d: Record<string, unknown> = {
      nid:                  this.nid,
      addresses:            this.addresses,
      capabilities:         this.capabilities,
      ttl:                  this.ttl,
      timestamp:            this.timestamp,
      heartbeat_interval_ms: this.heartbeat_interval_ms,
    };
    if (this.nodeType !== undefined) d["node_type"] = this.nodeType;
    if (this.node_roles !== undefined) d["node_roles"] = this.node_roles;
    if (this.cluster_anchor !== undefined) d["cluster_anchor"] = this.cluster_anchor;
    if (this.spawn_spec_ref !== undefined) d["spawn_spec_ref"] = this.spawn_spec_ref;
    if (this.bridge_protocols !== undefined) d["bridge_protocols"] = this.bridge_protocols;
    if (this.activation_mode !== undefined) d["activation_mode"] = this.activation_mode;
    if (this.activation_endpoint !== undefined) d["activation_endpoint"] = this.activation_endpoint;
    // NPS-CR-0009 / NPS-CR-0010: both participate in the Ed25519 signed body (contrast the
    // NDP v0.9 liveness fields below). Omitted entirely when unset, so the canonical bytes of
    // a frame that carries neither stay bit-identical to the pre-CR-0009 form — never emit
    // `null`/`0`/`[]` in place of omission, and never normalise absent → 1 before signing.
    if (this.cluster_epoch !== undefined) d["cluster_epoch"] = this.cluster_epoch;
    if (this.bridge_inbound_protocols !== undefined) {
      d["bridge_inbound_protocols"] = this.bridge_inbound_protocols;
    }
    if (this.graph_seq !== undefined) d["graph_seq"] = this.graph_seq;
    return d;
  }

  toDict(): Record<string, unknown> {
    const d: Record<string, unknown> = { ...this.unsignedDict(), signature: this.signature };
    // Liveness fields live on the wire only (not in unsignedDict → not signed).
    if (this.health !== undefined) d["health"] = this.health;
    if (this.last_seen !== undefined) d["last_seen"] = this.last_seen;
    return d;
  }

  static fromDict(data: Record<string, unknown>): AnnounceFrame {
    return new AnnounceFrame(
      data["nid"]                  as string,
      data["addresses"]            as NdpAddress[],
      data["capabilities"]         as string[],
      data["ttl"]                  as number,
      data["timestamp"]            as string,
      data["signature"]            as string,
      (data["node_type"]            as string | null) ?? undefined,
      ((data["node_roles"] ?? data["node_kind"]) as string[] | null) ?? undefined,
      (data["cluster_anchor"]       as string | null) ?? undefined,
      (data["spawn_spec_ref"]         as string | null) ?? undefined,
      (data["bridge_protocols"]       as string[] | null) ?? undefined,
      (data["activation_mode"]        as string | null) ?? undefined,
      (data["activation_endpoint"]    as NdpAddress | null) ?? undefined,
      (data["heartbeat_interval_ms"]  as number | null) ?? 60_000,
      (data["health"]                 as string | null) ?? undefined,
      (data["last_seen"]              as string | null) ?? undefined,
      (data["cluster_epoch"]          as number | null) ?? undefined,
      (data["bridge_inbound_protocols"] as string[] | null) ?? undefined,
      (data["graph_seq"]              as number | null) ?? undefined,
    );
  }

  /**
   * Effective cluster epoch for comparison purposes (NPS-CR-0009 §9): an absent
   * `cluster_epoch` reads as 1. Coercion happens **at comparison time only** — the stored
   * frame keeps `undefined` so its canonical bytes never change.
   */
  get effectiveClusterEpoch(): number {
    return this.cluster_epoch ?? 1;
  }
}

export class ResolveFrame implements NpsFrame {
  readonly frameType     = FrameType.RESOLVE;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly target:        string,
    public readonly requesterNid?: string,
    public readonly resolved?:     NdpResolveResult,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      target:        this.target,
      requester_nid: this.requesterNid ?? null,
      resolved:      this.resolved     ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): ResolveFrame {
    return new ResolveFrame(
      data["target"]         as string,
      (data["requester_nid"] as string | null) ?? undefined,
      (data["resolved"]      as NdpResolveResult | null) ?? undefined,
    );
  }
}

export interface GraphFrameData {
  graph_id:  string;
  nodes:     NdpGraphNode[];
  edges:     NdpGraphEdge[];
  ttl:       number;
  metadata?: Record<string, unknown>;
}

export class GraphFrame implements NpsFrame {
  readonly frameType     = FrameType.GRAPH;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly graph_id:  string,
    public readonly nodes:     readonly NdpGraphNode[],
    public readonly edges:     readonly NdpGraphEdge[],
    public readonly ttl:       number,
    public readonly metadata?: Record<string, unknown>,
  ) {
    validateGraphFrame(nodes, edges);
  }

  toDict(): Record<string, unknown> {
    return {
      graph_id:  this.graph_id,
      nodes:     this.nodes,
      edges:     this.edges,
      ttl:       this.ttl,
      metadata:  this.metadata ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): GraphFrame {
    return new GraphFrame(
      data["graph_id"] as string,
      (data["nodes"]   as NdpGraphNode[]) ?? [],
      (data["edges"]   as NdpGraphEdge[]) ?? [],
      data["ttl"]      as number,
      (data["metadata"] as Record<string, unknown> | null) ?? undefined,
    );
  }
}

function validateGraphFrame(nodes: readonly NdpGraphNode[], edges: readonly NdpGraphEdge[]): void {
  if (nodes.length > MAX_GRAPH_NODES) {
    throw new Error(`${NDP_GRAPH_TOO_LARGE}: nodes length exceeds ${MAX_GRAPH_NODES}`);
  }
  if (edges.length > MAX_GRAPH_EDGES) {
    throw new Error(`${NDP_GRAPH_TOO_LARGE}: edges length exceeds ${MAX_GRAPH_EDGES}`);
  }

  const nodeIds = new Set(nodes.map((node) => node.nid));
  if (nodes.some((node) => !node.nid)) {
    throw new Error(`${NDP_GRAPH_INVALID}: graph nodes require nid`);
  }
  for (const edge of edges) {
    if (!edge.from_nid || !edge.to_nid) {
      throw new Error(`${NDP_GRAPH_INVALID}: graph edges require from_nid and to_nid`);
    }
    if (edge.from_nid === edge.to_nid) {
      throw new Error(`${NDP_GRAPH_INVALID}: graph self-edges are forbidden`);
    }
    if (!nodeIds.has(edge.from_nid) || !nodeIds.has(edge.to_nid)) {
      throw new Error(`${NDP_GRAPH_INVALID}: graph edge endpoints must appear in nodes`);
    }
  }
}
