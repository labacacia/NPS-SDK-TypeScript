// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS-CR-0009 §3.2 — the Anchor **epoch fence** and leader check (NWP §12.2).
 *
 * There is no .NET implementation of this: the reference exposes the two error constants
 * but has no ownership surface at all. This is built from the CR text.
 *
 * Intra-cluster consensus (Raft/Paxos/lease store) is explicitly out of scope and
 * implementation-defined; only the observable wire contract below is normative.
 */

import {
  AnchorFailoverReason,
  anchorFailoverEvent,
  anchorQuorumLostEvent,
  type AnchorStateEvent,
} from "./anchor-client.js";
import { TopologyProtocolError } from "./anchor-server.js";
import {
  NWP_ANCHOR_EPOCH_FENCED,
  NWP_ANCHOR_NOT_LEADER,
} from "./nwp-error-codes.js";

/** Whether this Anchor currently owns its cluster. */
export type AnchorRole = "active" | "standby";

/** The subset of an inbound frame the fence inspects. */
export interface InboundEpochFrame {
  /** uint64; absent ⇒ 1. */
  cluster_epoch?: number;
  /** NID of the Anchor that sent the frame — becomes `successor_nid` when the fence fires. */
  sender_anchor_nid?: string;
}

export interface AnchorEpochFenceOptions {
  /** This Anchor's own NID. Used as `successor_nid` when it takes ownership. */
  anchorNid: string;
  /** Epoch this Anchor believes it owns the cluster under. Default 1 (single-Anchor). */
  ownEpoch?: number;
  /** Default `"active"` — a single-Anchor cluster is always its own leader. */
  role?: AnchorRole;
  /** Read-only-degraded (quorum lost). Default false. */
  degraded?: boolean;
  /** Sink for the `anchor_state` events the fence emits. */
  emit?: (event: AnchorStateEvent) => void;
  /** Invoked after the fence fires: a superseded leader MUST close its topology streams. */
  closeStreams?: () => void;
  /** Invoked with the NDP self-announcement `health` value when it changes. */
  onHealthChange?: (health: string) => void;
}

/**
 * Ownership state machine for one Anchor.
 *
 * ```
 * on_inbound_frame(frame, is_topology_write):
 *   (a) EPOCH FENCE  — first, on ANY inbound frame, read or write.
 *       inbound > own  ⇒ become STANDBY, emit a terminal anchor_failover, close streams,
 *                        raise NWP-ANCHOR-EPOCH-FENCED.
 *       inbound <= own ⇒ NOT an error.
 *   (b) LEADER CHECK — writes only. Not ACTIVE, or degraded ⇒ NWP-ANCHOR-NOT-LEADER.
 *   (c) reads always proceed; a standby MAY serve stale reads stamped with its last-known epoch.
 * ```
 *
 * Note the deliberate asymmetry with NDP resolution (§3.1): at the fence, an *equal* epoch is
 * accepted; at NDP resolution, an equal top epoch across two live members is the split-brain
 * fault. Do not "fix" either side to match the other.
 */
export class AnchorEpochFence {
  private _ownEpoch: number;
  private _role: AnchorRole;
  private _degraded: boolean;
  private _highestObserved: number;

  readonly anchorNid: string;
  private readonly emit?: (event: AnchorStateEvent) => void;
  private readonly closeStreams?: () => void;
  private readonly onHealthChange?: (health: string) => void;

  constructor(options: AnchorEpochFenceOptions) {
    if (!options.anchorNid) throw new Error("AnchorEpochFence requires an anchorNid.");
    this.anchorNid = options.anchorNid;
    this._ownEpoch = options.ownEpoch ?? 1;
    this._role = options.role ?? "active";
    this._degraded = options.degraded ?? false;
    this._highestObserved = this._ownEpoch;
    this.emit = options.emit;
    this.closeStreams = options.closeStreams;
    this.onHealthChange = options.onHealthChange;
  }

  get ownEpoch(): number { return this._ownEpoch; }
  get role(): AnchorRole { return this._role; }
  get degraded(): boolean { return this._degraded; }
  get isActive(): boolean { return this._role === "active" && !this._degraded; }

  /**
   * Apply the fence and (for writes) the leader check to one inbound frame.
   * Throws {@link TopologyProtocolError} — the transport renders it as an ErrorFrame;
   * `NPS-CLIENT-CONFLICT` maps to HTTP 409.
   */
  onInboundFrame(frame: InboundEpochFrame | undefined, isTopologyWrite = false): void {
    // (a) EPOCH FENCE — applies to ANY inbound frame, read or write.
    const inbound = frame?.cluster_epoch ?? 1;
    if (inbound > this._highestObserved) this._highestObserved = inbound;
    if (inbound > this._ownEpoch) {
      this._role = "standby";
      const successor = frame?.sender_anchor_nid ?? "";
      const event = anchorFailoverEvent(successor, inbound, AnchorFailoverReason.ACTIVE_LOST);
      this.emit?.(event);            // terminal anchor_failover
      this.closeStreams?.();         // then close all topology streams
      throw new TopologyProtocolError(
        NWP_ANCHOR_EPOCH_FENCED,
        "NPS-CLIENT-CONFLICT",
        `Inbound cluster_epoch ${inbound} supersedes this Anchor's epoch ${this._ownEpoch}; ` +
        `ownership has moved${successor ? ` to '${successor}'` : ""}.`,
      );
    }
    // inbound <= own epoch is NOT an error.

    // (b) LEADER CHECK — writes only.
    if (isTopologyWrite && !this.isActive) {
      throw new TopologyProtocolError(
        NWP_ANCHOR_NOT_LEADER,
        "NPS-CLIENT-CONFLICT",
        this._degraded
          ? `Anchor '${this.anchorNid}' is the cluster owner but read-only-degraded (quorum lost); ` +
            "topology writes are refused."
          : `Anchor '${this.anchorNid}' is a standby; only the active cluster owner accepts topology writes.`,
      );
    }

    // (c) reads always proceed.
  }

  /**
   * Stamp the current epoch onto a topology response. NWP §12.2: every
   * `topology.snapshot` / `topology.stream` response and every topology-mutating write
   * MUST carry the current `cluster_epoch`.
   */
  stampResponse<T extends object>(response: T): T & { cluster_epoch: number } {
    return { ...response, cluster_epoch: this._ownEpoch };
  }

  /** Quorum lost: go read-only-degraded, emit `anchor_quorum_lost`, go `health: "degraded"`. */
  onQuorumLost(quorumSize: number, available: number): AnchorStateEvent {
    this._degraded = true;
    const event = anchorQuorumLostEvent(quorumSize, available);
    this.emit?.(event);
    this.onHealthChange?.("degraded");
    return event;
  }

  /** Quorum regained: leave the read-only-degraded state. */
  onQuorumRestored(): void {
    this._degraded = false;
    this.onHealthChange?.("healthy");
  }

  /**
   * Take ownership at `newEpoch`. The epoch MUST be **strictly greater** than every epoch
   * ever observed by this Anchor — that monotonicity is what makes it a fencing token.
   *
   * The caller MUST then re-sign and re-publish its AnnounceFrame with
   * `cluster_epoch = newEpoch` (§1.1 — the field is inside the signed body).
   */
  takeOwnership(newEpoch: number, reason: string = AnchorFailoverReason.PLANNED): AnchorStateEvent {
    if (!Number.isInteger(newEpoch) || newEpoch <= this._highestObserved) {
      throw new RangeError(
        `cluster_epoch must strictly increase: ${newEpoch} is not greater than the highest ` +
        `epoch observed (${this._highestObserved}).`,
      );
    }
    this._ownEpoch = newEpoch;
    this._highestObserved = newEpoch;
    this._role = "active";
    this._degraded = false;
    const event = anchorFailoverEvent(this.anchorNid, newEpoch, reason);
    this.emit?.(event);
    return event;
  }
}
