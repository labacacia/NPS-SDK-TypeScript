// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * AnchorNodeClient — typed HTTP client for an Anchor Node's reserved query
 * types (NPS-2 §12 — `topology.snapshot` and `topology.stream`).
 *
 * Uses `fetch` only; no extra dependencies.
 */

// ── Wire constants ────────────────────────────────────────────────────────────

const SCOPE_CLUSTER = "cluster";
const SCOPE_MEMBER  = "member";
const TYPE_SNAPSHOT = "topology.snapshot";
const TYPE_STREAM   = "topology.stream";
const EVENT_MEMBER_JOINED   = "member_joined";
const EVENT_MEMBER_LEFT     = "member_left";
const EVENT_MEMBER_UPDATED  = "member_updated";
const EVENT_ANCHOR_STATE    = "anchor_state";
const EVENT_RESYNC_REQUIRED = "resync_required";

// ── Interfaces / types ────────────────────────────────────────────────────────

export interface MemberInfo {
  nid: string;
  node_roles: string[];
  activation_mode: string;
  child_anchor?: boolean;
  member_count?: number;
  tags?: string[];
  joined_at?: string;
  last_seen?: string;
  capabilities?: unknown;
  metrics?: unknown;
}

export interface TopologySnapshot {
  version: number;
  anchor_nid: string;
  cluster_size: number;
  members: MemberInfo[];
  truncated?: boolean;
  /**
   * NPS-CR-0009 — epoch under which the responding Anchor owns this cluster. uint64, absent
   * ⇒ 1. Not signed. Per NWP §12.2 every `topology.snapshot` / `topology.stream` response and
   * every topology-mutating write MUST carry the current `cluster_epoch`.
   */
  cluster_epoch?: number;
}

export interface TopologyFilter {
  tags_any?: string[];
  tags_all?: string[];
  node_roles?: string[];
}

export interface MemberChanges {
  node_roles?: string[];
  activation_mode?: string;
  tags?: string[];
  member_count?: number;
  last_seen?: string;
  capabilities?: unknown;
  metrics?: unknown;
}

/**
 * `anchor_state` sub-type tags. These live on the AnchorState event type, **not** on the
 * shared `TopologyWire` constant bag — mirroring the .NET placement.
 */
export const AnchorStateField = {
  /** Anchor restarted and reset its monotonic version counter (NPS-2 §12.3). */
  VERSION_REBASED:    "version_rebased",
  /** Cluster ownership transferred to a peer Anchor (NPS-CR-0009). */
  ANCHOR_FAILOVER:    "anchor_failover",
  /** Cluster lost its ownership quorum and is now read-only (NPS-CR-0009). */
  ANCHOR_QUORUM_LOST: "anchor_quorum_lost",
} as const;

/** `anchor_failover` reason enum (NPS-CR-0009). */
export const AnchorFailoverReason = {
  PLANNED:     "planned",
  ACTIVE_LOST: "active_lost",
} as const;

/** `details` payload of an `anchor_failover` event — every key is a fixed wire key. */
export interface AnchorFailoverDetails {
  /** NID of the Anchor that took ownership. */
  successor_nid: string;
  /** The new, strictly-greater epoch. uint64. */
  cluster_epoch: number;
  /** `"planned"` | `"active_lost"`. */
  reason: string;
}

/** `details` payload of an `anchor_quorum_lost` event. Both keys required, uint32. */
export interface AnchorQuorumLostDetails {
  quorum_size: number;
  available: number;
}

/** Discriminated union for topology stream events (NPS-2 §12.2). */
export type TopologyEvent =
  | { kind: "member_joined";   version: number; member: MemberInfo }
  | { kind: "member_left";     version: number; nid: string }
  | { kind: "member_updated";  version: number; nid: string; changes: MemberChanges }
  // NPS-CR-0009 sub-types, modelled as their own variants of the union so that `details`
  // is typed rather than `unknown` when the sub-type tag is known.
  | { kind: "anchor_state";    version: number; field: "anchor_failover";    details: AnchorFailoverDetails }
  | { kind: "anchor_state";    version: number; field: "anchor_quorum_lost"; details: AnchorQuorumLostDetails }
  | { kind: "anchor_state";    version: number; field: string; details?: unknown }
  | { kind: "resync_required"; version: 0;      reason: string };

/** An `anchor_state` event, narrowed. */
export type AnchorStateEvent = Extract<TopologyEvent, { kind: "anchor_state" }>;

/**
 * NPS-CR-0009 `anchor_failover`: cluster ownership moved to `successorNid` at `clusterEpoch`.
 * `reason` defaults to `"planned"` (the factory default asserted by the reference tests).
 */
export function anchorFailoverEvent(
  successorNid: string,
  clusterEpoch: number,
  reason: string = AnchorFailoverReason.PLANNED,
  version = 0,
): AnchorStateEvent {
  return {
    kind: "anchor_state",
    version,
    field: AnchorStateField.ANCHOR_FAILOVER,
    details: { successor_nid: successorNid, cluster_epoch: clusterEpoch, reason },
  };
}

/**
 * NPS-CR-0009 `anchor_quorum_lost`: the cluster is read-only (degraded); only `available`
 * of `quorumSize` Anchors are reachable.
 */
export function anchorQuorumLostEvent(
  quorumSize: number,
  available: number,
  version = 0,
): AnchorStateEvent {
  return {
    kind: "anchor_state",
    version,
    field: AnchorStateField.ANCHOR_QUORUM_LOST,
    details: { quorum_size: quorumSize, available },
  };
}

/**
 * Surfaces an Anchor-side topology error to the caller. `nwpErrorCode` matches
 * one of the NWP-TOPOLOGY-* codes; `npsStatus` is the NPS status code.
 */
export class AnchorTopologyError extends Error {
  constructor(
    public readonly nwpErrorCode: string,
    public readonly npsStatus: string,
    message?: string,
  ) {
    super(message);
    this.name = "AnchorTopologyError";
  }
}

// ── AnchorNodeClient ──────────────────────────────────────────────────────────

/**
 * Typed client for an Anchor Node's reserved query endpoints.
 *
 * ```ts
 * const client = new AnchorNodeClient("http://anchor.local:8080", "/anchor");
 *
 * const snap = await client.getSnapshot({ scope: "cluster" });
 * for await (const ev of client.subscribe({ sinceVersion: snap.version })) {
 *   console.log(ev);
 * }
 * ```
 */
export class AnchorNodeClient {
  private readonly baseUrl: string;
  private readonly pathPrefix: string;

  constructor(baseUrl: string, pathPrefix: string = "") {
    // Normalise trailing slashes once.
    this.baseUrl    = baseUrl.replace(/\/$/, "");
    this.pathPrefix = pathPrefix.replace(/\/$/, "");
  }

  // ── topology.snapshot ──────────────────────────────────────────────────────

  /**
   * Fetch the current cluster topology (NPS-2 §12.1).
   *
   * POSTs a `topology.snapshot` query and returns the first `data` element of
   * the response CapsFrame.
   */
  async getSnapshot(options?: {
    scope?: "cluster" | "member";
    include?: string[];
    depth?: number;
    targetNid?: string;
  }): Promise<TopologySnapshot> {
    const scope = options?.scope ?? "cluster";
    const include = options?.include ?? ["members"];
    const depth = options?.depth;
    const targetNid = options?.targetNid;

    const topology: Record<string, unknown> = {
      scope: scope === "cluster" ? SCOPE_CLUSTER : SCOPE_MEMBER,
      include,
    };
    if (depth !== undefined) topology["depth"] = depth;
    if (targetNid !== undefined) topology["target_nid"] = targetNid;

    const body = { type: TYPE_SNAPSHOT, topology };

    const url = `${this.baseUrl}${this.pathPrefix}/query`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw await buildFetchError("topology.snapshot", res);
    }

    const caps = await res.json() as { data: TopologySnapshot[] };
    const rows = caps.data;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(
        `topology.snapshot expected exactly 1 data row; got ${Array.isArray(rows) ? rows.length : "non-array"}.`,
      );
    }
    return rows[0];
  }

  // ── topology.stream ────────────────────────────────────────────────────────

  /**
   * Subscribe to live topology changes (NPS-2 §12.2).
   *
   * The first NDJSON line (subscription ack) is automatically skipped. Each
   * subsequent line is parsed into a `TopologyEvent`. The generator stops after
   * a `resync_required` event — callers MUST issue a fresh `getSnapshot` before
   * resubscribing.
   */
  async *subscribe(options?: {
    filter?: TopologyFilter;
    sinceVersion?: number;
    scope?: "cluster" | "member";
  }): AsyncGenerator<TopologyEvent> {
    const scope = options?.scope ?? "cluster";
    const filter = options?.filter;
    const sinceVersion = options?.sinceVersion;

    const topology: Record<string, unknown> = {
      scope: scope === "cluster" ? SCOPE_CLUSTER : SCOPE_MEMBER,
    };
    if (filter !== undefined) topology["filter"] = filter;
    if (sinceVersion !== undefined) topology["since_version"] = sinceVersion;

    const body = {
      type:      TYPE_STREAM,
      action:    "subscribe",
      stream_id: crypto.randomUUID(),
      topology,
    };

    const url = `${this.baseUrl}${this.pathPrefix}/subscribe`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept":       "application/x-ndjson",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw await buildFetchError("topology.stream", res);
    }
    if (res.body === null) return;

    let ackSkipped = false;

    for await (const line of readNdjsonLines(res.body)) {
      // Skip the first non-empty line (subscription ack).
      if (!ackSkipped) {
        ackSkipped = true;
        continue;
      }

      // Mid-stream protocol error: { status, error } with no event_type.
      const maybeErr = tryParseStreamError(line);
      if (maybeErr !== null) throw maybeErr;

      const ev = parseTopologyEvent(line);
      if (ev === null) continue;

      yield ev;

      if (ev.kind === EVENT_RESYNC_REQUIRED) return;
    }
  }
}

// ── NDJSON line reader ────────────────────────────────────────────────────────

/**
 * Reads a `ReadableStream<Uint8Array>` and yields complete, non-empty lines.
 * Lines are split on `\n`; trailing `\r` is stripped.
 */
async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.length > 0) yield line;
      }
    }

    // Flush decoder.
    buffer += decoder.decode();
    const remaining = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (remaining.length > 0) yield remaining;
  } finally {
    reader.releaseLock();
  }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/** Returns an `AnchorTopologyError` if the line is an error frame, else null. */
function tryParseStreamError(line: string): AnchorTopologyError | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    if ("event_type" in obj) return null; // It's a regular event line.
    if (typeof obj["error"] !== "string") return null;
    if (typeof obj["status"] !== "string") return null;
    const msg = typeof obj["message"] === "string" ? obj["message"] : undefined;
    return new AnchorTopologyError(obj["error"] as string, obj["status"] as string, msg);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses one NDJSON event line into a `TopologyEvent`, or null if unrecognised. */
function parseTopologyEvent(line: string): TopologyEvent | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;

  const eventType = obj["event_type"];
  if (typeof eventType !== "string") return null;

  const version = typeof obj["seq"] === "number" ? (obj["seq"] as number) : 0;
  const payload = (obj["payload"] ?? {}) as Record<string, unknown>;

  switch (eventType) {
    case EVENT_MEMBER_JOINED:
      return {
        kind:    "member_joined",
        version,
        member:  payload as unknown as MemberInfo,
      };

    case EVENT_MEMBER_LEFT:
      return {
        kind:    "member_left",
        version,
        nid:     typeof payload["nid"] === "string" ? payload["nid"] : "",
      };

    case EVENT_MEMBER_UPDATED:
      return {
        kind:    "member_updated",
        version,
        nid:     typeof payload["nid"] === "string" ? payload["nid"] : "",
        changes: (payload["changes"] ?? {}) as MemberChanges,
      };

    case EVENT_ANCHOR_STATE: {
      const field   = typeof payload["field"] === "string" ? payload["field"] : "";
      const details = payload["details"];
      // NPS-CR-0009 sub-types decode into their typed `details` shape; every other
      // sub-type (including ones this SDK does not know) passes through unchanged —
      // subscribers MUST ignore unknown `anchor_state` sub-types.
      if (field === AnchorStateField.ANCHOR_FAILOVER && isObject(details)) {
        return {
          kind: "anchor_state", version, field: AnchorStateField.ANCHOR_FAILOVER,
          details: {
            successor_nid: String(details["successor_nid"] ?? ""),
            cluster_epoch: Number(details["cluster_epoch"] ?? 1),
            reason:        String(details["reason"] ?? AnchorFailoverReason.PLANNED),
          },
        };
      }
      if (field === AnchorStateField.ANCHOR_QUORUM_LOST && isObject(details)) {
        return {
          kind: "anchor_state", version, field: AnchorStateField.ANCHOR_QUORUM_LOST,
          details: {
            quorum_size: Number(details["quorum_size"] ?? 0),
            available:   Number(details["available"] ?? 0),
          },
        };
      }
      return { kind: "anchor_state", version, field, details };
    }

    case EVENT_RESYNC_REQUIRED:
      return {
        kind:    "resync_required",
        version: 0,
        reason:  typeof payload["reason"] === "string" ? payload["reason"] : "unknown",
      };

    default:
      return null;
  }
}

/** Builds an `AnchorTopologyError` from a non-ok HTTP response. */
async function buildFetchError(
  operation: string,
  res: Response,
): Promise<AnchorTopologyError> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = "";
  }

  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof obj === "object" && obj !== null &&
      typeof obj["error"] === "string" &&
      typeof obj["status"] === "string"
    ) {
      const msg = typeof obj["message"] === "string" ? obj["message"] : body;
      return new AnchorTopologyError(obj["error"] as string, obj["status"] as string, msg);
    }
  } catch { /* fall through */ }

  return new AnchorTopologyError(
    "UNKNOWN",
    `HTTP-${res.status}`,
    `${operation} returned ${res.status}: ${body}`,
  );
}
