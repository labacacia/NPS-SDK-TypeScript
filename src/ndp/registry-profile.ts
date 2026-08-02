// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, createHash, verify } from "node:crypto";
import {
  NDP_ANNOUNCE_CONFLICT,
  NDP_ANNOUNCE_PROFILE_VIOLATION,
  NDP_ANNOUNCE_SIGNATURE_INVALID,
  NDP_ANNOUNCE_STALE,
  NDP_CLUSTER_SPLIT,
  NDP_GRAPH_SEQ_ROLLBACK,
} from "./ndp-error-codes.js";

export type NdpRegistryDecision =
  "accepted" | "duplicate" | "refreshed" | "removed" | "rejected";

export interface NdpRegistryAdmission {
  decision: NdpRegistryDecision;
  errorCode?: string;
}

export interface NdpClusterSelection {
  nid?: string;
  epoch?: number;
  errorCode?: string;
}

interface RegistryEntry {
  frame: Record<string, unknown>;
  signedDigest: string;
  expiresAt: number;
}

const EXCLUDED = new Set(["frame", "signature", "health", "last_seen"]);

/** Canonical NDP 0.12 Announce signed body. */
export function canonicalAnnounceJson(frame: Record<string, unknown>): string {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (!EXCLUDED.has(key) && value !== null && value !== undefined) {
      root[key] = withoutNulls(value);
    }
  }
  root["heartbeat_interval_ms"] ??= 60_000;
  return JSON.stringify(sortObject(root));
}

/** Verify an `ed25519:<base64url>` signature over an Announce signed body. */
export function verifyAnnounceSignature(
  frame: Record<string, unknown>,
  encodedPublicKey: string,
  encodedSignature: string,
): boolean {
  const prefix = "ed25519:";
  if (
    !encodedPublicKey.startsWith(prefix) ||
    !encodedSignature.startsWith(prefix)
  ) {
    return false;
  }
  try {
    const raw = Buffer.from(encodedPublicKey.slice(prefix.length), "base64url");
    if (raw.length !== 32) return false;
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      raw,
    ]);
    const publicKey = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(canonicalAnnounceJson(frame), "utf8"),
      publicKey,
      Buffer.from(encodedSignature.slice(prefix.length), "base64url"),
    );
  } catch {
    return false;
  }
}

/** Transport-independent NDP 0.12 in-memory registry state machine. */
export class NdpRegistryProfile {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly sequences = new Map<string, number>();

  constructor(readonly securityProfile = "local-dev") {}

  applyAnnounce(
    frame: Record<string, unknown>,
    signatureValid: boolean,
    receivedAt: Date,
  ): NdpRegistryAdmission {
    if (!signatureValid) return reject(NDP_ANNOUNCE_SIGNATURE_INVALID);

    const nid = stringValue(frame, "nid");
    const timestamp = timeValue(frame, "timestamp");
    if (!nid || timestamp === undefined) {
      return reject(NDP_ANNOUNCE_PROFILE_VIOLATION);
    }

    const sequencePresent = Object.hasOwn(frame, "graph_seq");
    const parsedSequence = unsignedInteger(frame["graph_seq"]);
    const ttl = unsignedInteger(frame["ttl"], 0xffff_ffff);
    if (
      (sequencePresent && parsedSequence === undefined) ||
      (!sequencePresent && this.securityProfile !== "local-dev") ||
      ttl === undefined
    ) {
      return reject(NDP_ANNOUNCE_PROFILE_VIOLATION);
    }
    const sequence = parsedSequence ?? 0;
    if (!bridgeShapeIsValid(frame)) {
      return reject(NDP_ANNOUNCE_PROFILE_VIOLATION);
    }
    if (
      this.securityProfile !== "local-dev" &&
      Math.abs(receivedAt.getTime() - timestamp) > 300_000
    ) {
      return reject(NDP_ANNOUNCE_SIGNATURE_INVALID);
    }

    const digest = createHash("sha256")
      .update(canonicalAnnounceJson(frame), "utf8")
      .digest("hex");
    const highest = this.sequences.get(nid);
    if (highest !== undefined) {
      if (sequence < highest) return reject(NDP_GRAPH_SEQ_ROLLBACK);
      if (sequence === highest) {
        const current = this.entries.get(nid);
        if (!current) return { decision: "duplicate" };
        if (current.signedDigest !== digest)
          return reject(NDP_ANNOUNCE_CONFLICT);
        if (sameLiveness(current.frame, frame))
          return { decision: "duplicate" };
        const expiresAt = freshnessDeadline(frame);
        if (expiresAt === undefined || expiresAt <= receivedAt.getTime()) {
          return reject(NDP_ANNOUNCE_STALE);
        }
        this.entries.set(nid, {
          frame: structuredClone(frame),
          signedDigest: digest,
          expiresAt,
        });
        return { decision: "refreshed" };
      }
    }

    if (ttl === 0) {
      this.sequences.set(nid, sequence);
      this.entries.delete(nid);
      return { decision: "removed" };
    }

    const expiresAt = freshnessDeadline(frame);
    if (expiresAt === undefined || expiresAt <= receivedAt.getTime()) {
      return reject(NDP_ANNOUNCE_STALE);
    }
    this.sequences.set(nid, sequence);
    this.entries.set(nid, {
      frame: structuredClone(frame),
      signedDigest: digest,
      expiresAt,
    });
    return { decision: "accepted" };
  }

  liveNids(now: Date): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.expiresAt > now.getTime())
      .map(([nid]) => nid)
      .sort();
  }

  highestSequences(): Record<string, number> {
    return Object.fromEntries(
      [...this.sequences.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  hasStaleEntry(now: Date): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.expiresAt <= now.getTime(),
    );
  }

  resolveCluster(clusterAnchor: string, now: Date): NdpClusterSelection {
    const members = [...this.entries.entries()]
      .filter(
        ([, entry]) =>
          entry.expiresAt > now.getTime() &&
          stringValue(entry.frame, "cluster_anchor") === clusterAnchor &&
          roles(entry.frame).includes("anchor"),
      )
      .map(([nid, entry]) => ({
        nid,
        epoch: numberValue(entry.frame, "cluster_epoch") ?? 1,
      }));
    if (members.length === 0) return {};
    const top = Math.max(...members.map((member) => member.epoch));
    const leaders = members
      .filter((member) => member.epoch === top)
      .sort((left, right) => left.nid.localeCompare(right.nid));
    return leaders.length === 1
      ? { nid: leaders[0]!.nid, epoch: top }
      : { errorCode: NDP_CLUSTER_SPLIT };
  }

  discoverBridges(direction: string, protocol: string, now: Date): string[] {
    if (direction !== "inbound" && direction !== "outbound") {
      throw new Error("Bridge direction must be 'inbound' or 'outbound'.");
    }
    const field =
      direction === "inbound" ? "bridge_inbound_protocols" : "bridge_protocols";
    return [...this.entries.entries()]
      .filter(
        ([, entry]) =>
          entry.expiresAt > now.getTime() &&
          stringValue(entry.frame, "health") !== "draining" &&
          isBridge(entry.frame) &&
          strings(entry.frame, field).includes(protocol),
      )
      .map(([nid]) => nid)
      .sort();
  }
}

function reject(errorCode: string): NdpRegistryAdmission {
  return { decision: "rejected", errorCode };
}

function bridgeShapeIsValid(frame: Record<string, unknown>): boolean {
  const outbound = protocolList(frame, "bridge_protocols");
  const inbound = protocolList(frame, "bridge_inbound_protocols");
  if (!outbound || !inbound) return false;
  return isBridge(frame)
    ? outbound.values.length + inbound.values.length > 0
    : !outbound.present && !inbound.present;
}

function protocolList(
  frame: Record<string, unknown>,
  field: string,
): { present: boolean; values: string[] } | undefined {
  if (!Object.hasOwn(frame, field)) return { present: false, values: [] };
  const value = frame[field];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    return undefined;
  }
  return { present: true, values: value };
}

function isBridge(frame: Record<string, unknown>): boolean {
  return (
    roles(frame).includes("bridge") ||
    stringValue(frame, "node_type") === "bridge"
  );
}

function roles(frame: Record<string, unknown>): string[] {
  return strings(frame, "node_roles");
}

function strings(frame: Record<string, unknown>, field: string): string[] {
  const value = frame[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameLiveness(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    left["health"] === right["health"] &&
    left["last_seen"] === right["last_seen"]
  );
}

function freshnessDeadline(frame: Record<string, unknown>): number | undefined {
  const source = timeValue(frame, "last_seen") ?? timeValue(frame, "timestamp");
  return source === undefined
    ? undefined
    : source + (numberValue(frame, "ttl") ?? 0) * 1000;
}

function stringValue(
  frame: Record<string, unknown>,
  field: string,
): string | undefined {
  return typeof frame[field] === "string" ? frame[field] : undefined;
}

function numberValue(
  frame: Record<string, unknown>,
  field: string,
): number | undefined {
  return typeof frame[field] === "number" ? frame[field] : undefined;
}

function unsignedInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}

function timeValue(
  frame: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = stringValue(frame, field);
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  }
  return value;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortObject(object[key])]),
    );
  }
  return value;
}
