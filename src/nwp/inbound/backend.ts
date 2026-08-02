// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbound Bridge **backend abstraction** (NPS-CR-0010).
 *
 * The consolidation is a backend abstraction, not a deletion: two deployment shapes, one
 * interface. The protocol servers (MCP / A2A / gRPC) are written against {@link INwpBackend}
 * alone and are unaware of which shape they are serving.
 *
 * ```
 * INwpBackend ──┬── InProcessNwpBackend   (delegate dispatch — the SDK's shape)
 *               └── HttpNwpBackend        (HTTP to a remote node — the gateway shape)
 * ```
 */

import { isErrorFrame } from "../../ncp/frames/error-frame.js";
import { NpsStatusCodes } from "../../core/status-codes.js";
import { ActionFrame, QueryFrame } from "../frames.js";
import { BridgeErrorCodes, fromHttpStatus } from "./error-map.js";

const S = NpsStatusCodes;

// ── Node role / descriptors ──────────────────────────────────────────────────

/** Role an NWP node carries, as reported by its NWM `node_type` (NWP §4.1). */
export enum NwpNodeRole {
  /** Role could not be determined (NWM unreachable or unrecognised value). */
  UNKNOWN = "unknown",
  /** Memory Node — queryable. Projected onto a foreign protocol's read surface. */
  MEMORY  = "memory",
  /** Action Node — invokable. Projected onto a foreign protocol's call surface. */
  ACTION  = "action",
  /** Complex Node — both queryable and invokable. */
  COMPLEX = "complex",
  /** Anchor Node — cluster control plane. Not projected by inbound Bridges. */
  ANCHOR  = "anchor",
  /** Bridge Node — translation. Not projected by inbound Bridges. */
  BRIDGE  = "bridge",
}

/** Parse an NWM `node_type` string into a role. Unrecognised ⇒ {@link NwpNodeRole.UNKNOWN}. */
export function parseNodeRole(nodeType: string | undefined | null): NwpNodeRole {
  switch (nodeType?.toLowerCase()) {
    case "memory":  return NwpNodeRole.MEMORY;
    case "action":  return NwpNodeRole.ACTION;
    case "complex": return NwpNodeRole.COMPLEX;
    case "anchor":  return NwpNodeRole.ANCHOR;
    case "bridge":  return NwpNodeRole.BRIDGE;
    default:        return NwpNodeRole.UNKNOWN;
  }
}

/** Identity and role of one NWP node fronted by an inbound Bridge server. */
export interface NwpNodeDescriptor {
  /** Logical name. Namespaces MCP resource URIs and tool names, so it MUST be unique per Bridge. */
  name: string;
  role: NwpNodeRole;
  /** Human-readable name surfaced to foreign clients. Falls back to {@link name}. */
  displayName?: string;
  description?: string;
}

/** Whether this node exposes a queryable surface (Memory / Complex). */
export function isQueryable(d: NwpNodeDescriptor): boolean {
  return d.role === NwpNodeRole.MEMORY || d.role === NwpNodeRole.COMPLEX;
}

/** Whether this node exposes an invokable surface (Action / Complex). */
export function isInvokable(d: NwpNodeDescriptor): boolean {
  return d.role === NwpNodeRole.ACTION || d.role === NwpNodeRole.COMPLEX;
}

/** One action exposed by an NWP node, projected onto a foreign protocol's call surface. */
export interface NwpActionDescriptor {
  actionId: string;
  description?: string;
  /** JSON Schema for the arguments. Absent ⇒ an open object schema is advertised. */
  inputSchema?: unknown;
  /** Whether invocations should request async execution. */
  async?: boolean;
  /** Optional tags (A2A skill tags). */
  tags?: readonly string[];
}

/** The open object schema advertised when an action declares none. */
export function openObjectSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: true };
}

// ── NwpResult ────────────────────────────────────────────────────────────────

/**
 * Outcome of one NWP operation performed on behalf of a foreign client. It carries either a
 * payload or an **NPS status**, which is what lets inbound servers map failures onto their
 * protocol's error space per NWP §16.3 instead of forwarding an opaque body.
 */
export interface NwpResult {
  ok: boolean;
  payload?: unknown;
  /** NPS status code (spec/status-codes.md) when not ok. */
  npsStatus?: string;
  /** NWP protocol error code (spec/error-codes.md) when not ok. */
  nwpError?: string;
  message?: string;
}

export const NwpResult = {
  success(payload: unknown): NwpResult {
    return { ok: true, payload };
  },
  failure(npsStatus: string, nwpError?: string, message?: string): NwpResult {
    return { ok: false, npsStatus, nwpError, message };
  },
  /** A failed result for an unexpected dispatch fault. */
  dispatchFailed(message: string): NwpResult {
    return NwpResult.failure(S.NPS_SERVER_INTERNAL, BridgeErrorCodes.SERVER_DISPATCH_FAILED, message);
  },
} as const;

// ── The interface ────────────────────────────────────────────────────────────

/**
 * One NWP node reachable by an inbound Bridge server (NWP §2.1 inbound profile).
 * Implementations front either a local in-process node ({@link InProcessNwpBackend}) or a
 * remote node over HTTP ({@link HttpNwpBackend}).
 */
export interface INwpBackend {
  /** Identity and role of the fronted node. */
  getDescriptor(signal?: AbortSignal): Promise<NwpNodeDescriptor>;
  /** The node's raw NWM (`/.nwm`) document. */
  getManifest(signal?: AbortSignal): Promise<NwpResult>;
  /** Actions this node exposes. Empty for a node that is not invokable. */
  getActions(signal?: AbortSignal): Promise<readonly NwpActionDescriptor[]>;
  /** Run an NWP Query. Only meaningful when the node is queryable. */
  query(query: unknown, signal?: AbortSignal): Promise<NwpResult>;
  /** Run an NWP Invoke. Only meaningful when the node is invokable. */
  invoke(actionId: string, args: unknown, async: boolean, signal?: AbortSignal): Promise<NwpResult>;
}

// ── In-process backend ───────────────────────────────────────────────────────

/** Dispatches an ActionFrame to a co-hosted NPS node. */
export type NwpInProcessActionDispatcher =
  (frame: ActionFrame, signal?: AbortSignal) => Promise<unknown>;

/**
 * Dispatches a QueryFrame to a co-hosted NPS Memory / Complex Node. Optional: a deployment
 * that fronts only Action Nodes leaves this unset, and its inbound Bridge then serves
 * `resources/*` over an empty resource set — still conformant, since NWP §16.1.2 requires the
 * *methods* to be served, not that a Memory Node exist behind them.
 */
export type NwpInProcessQueryDispatcher =
  (frame: QueryFrame, signal?: AbortSignal) => Promise<unknown>;

/**
 * An {@link INwpBackend} that dispatches in-process, with no network hop — the shape where an
 * NPS node additionally serves a foreign protocol itself.
 */
export class InProcessNwpBackend implements INwpBackend {
  constructor(
    private readonly descriptor: NwpNodeDescriptor,
    private readonly actions: readonly NwpActionDescriptor[] = [],
    private readonly invokeDelegate?: NwpInProcessActionDispatcher,
    private readonly queryDelegate?: NwpInProcessQueryDispatcher,
  ) {}

  async getDescriptor(): Promise<NwpNodeDescriptor> {
    return this.descriptor;
  }

  async getManifest(): Promise<NwpResult> {
    return NwpResult.success({
      node_type:    this.descriptor.role,
      display_name: this.descriptor.displayName ?? this.descriptor.name,
      description:  this.descriptor.description,
    });
  }

  async getActions(): Promise<readonly NwpActionDescriptor[]> {
    return isInvokable(this.descriptor) ? this.actions : [];
  }

  async query(query: unknown, signal?: AbortSignal): Promise<NwpResult> {
    if (!isQueryable(this.descriptor)) {
      return NwpResult.failure(S.NPS_SERVER_UNSUPPORTED, BridgeErrorCodes.SERVER_TOOL_NOT_FOUND,
        `Node '${this.descriptor.name}' is not queryable (role: ${this.descriptor.role}).`);
    }
    if (!this.queryDelegate) {
      return NwpResult.failure(S.NPS_SERVER_INTERNAL, BridgeErrorCodes.SERVER_DISPATCHER_MISSING,
        `Node '${this.descriptor.name}' declares a queryable role but no query dispatcher was configured.`);
    }
    const frame = new QueryFrame(undefined, (query ?? {}) as Record<string, unknown>);
    try {
      return toResult(await this.queryDelegate(frame, signal));
    } catch (e) {
      return NwpResult.dispatchFailed(errorMessage(e));
    }
  }

  async invoke(actionId: string, args: unknown, async: boolean, signal?: AbortSignal): Promise<NwpResult> {
    if (!this.invokeDelegate) {
      return NwpResult.failure(S.NPS_SERVER_INTERNAL, BridgeErrorCodes.SERVER_DISPATCHER_MISSING,
        `Node '${this.descriptor.name}' has no action dispatcher configured.`);
    }
    const frame = new ActionFrame(actionId, (args ?? undefined) as Record<string, unknown> | undefined, async);
    try {
      return toResult(await this.invokeDelegate(frame, signal));
    } catch (e) {
      return NwpResult.dispatchFailed(errorMessage(e));
    }
  }
}

/**
 * Project a co-hosted node's frame response onto {@link NwpResult}, preserving the NPS status
 * so the inbound server can map it per NWP §16.3 rather than forwarding an opaque body.
 */
function toResult(frame: unknown): NwpResult {
  if (isErrorFrame(frame)) {
    return NwpResult.failure(frame.status || S.NPS_SERVER_INTERNAL, frame.error, frame.message);
  }
  // Frame classes serialise through toDict(); plain objects pass through.
  const payload = typeof (frame as { toDict?: () => unknown })?.toDict === "function"
    ? (frame as { toDict: () => unknown }).toDict()
    : frame;
  return NwpResult.success(payload);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── HTTP backend ─────────────────────────────────────────────────────────────

/** Declares one remote NWP node that an inbound Bridge server fronts over HTTP. */
export interface NwpUpstream {
  /** Logical name. Namespaces MCP resource URIs and tool names — MUST be unique per Bridge. */
  name: string;
  /** Base URL of the NWP node (scheme + host + path prefix, no trailing slash). */
  baseUrl: string;
  /** Optional Agent NID forwarded as `X-NWP-Agent`. */
  agentNid?: string;
  /** Optional bearer token or similar, forwarded as `Authorization`. */
  authHeader?: string;
  /** Max rows a single query may pull from a Memory Node. NWP's own page cap is 1000. */
  readLimit?: number;
}

/** The `fetch` shape {@link HttpNwpBackend} needs — inject a fake in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * An {@link INwpBackend} that fronts a **remote** NWP node over HTTP — the standalone-gateway
 * shape the `compat/*-ingress` packages shipped before NPS-CR-0010 absorbed them.
 * Reads `/.nwm`, `/actions`, `/query`, `/invoke`.
 */
export class HttpNwpBackend implements INwpBackend {
  private cached?: NwpNodeDescriptor;

  constructor(
    public readonly upstream: NwpUpstream,
    private readonly fetchImpl: FetchLike = ((i, init) => fetch(i, init)) as FetchLike,
  ) {}

  async getDescriptor(signal?: AbortSignal): Promise<NwpNodeDescriptor> {
    if (this.cached) return this.cached;
    try {
      const res = await this.send("GET", "/.nwm", undefined, signal);
      if (!res.ok) return (this.cached = this.unknown());
      const nwm = await res.json() as Record<string, unknown>;
      return (this.cached = {
        name:        this.upstream.name,
        role:        parseNodeRole(nwm?.["node_type"] as string | undefined),
        displayName: nwm?.["display_name"] as string | undefined,
        description: nwm?.["description"] as string | undefined,
      });
    } catch {
      // An unreachable NWM must not take the whole Bridge down: the node is simply
      // projected onto nothing until it comes back.
      return (this.cached = this.unknown());
    }
  }

  getManifest(signal?: AbortSignal): Promise<NwpResult> {
    return this.sendForResult("GET", "/.nwm", undefined, signal);
  }

  async getActions(signal?: AbortSignal): Promise<readonly NwpActionDescriptor[]> {
    const descriptor = await this.getDescriptor(signal);
    if (!isInvokable(descriptor)) return [];

    let body: Record<string, unknown>;
    try {
      const res = await this.send("GET", "/actions", undefined, signal);
      if (!res.ok) return [];
      body = await res.json() as Record<string, unknown>;
    } catch {
      return [];
    }
    const actions = body?.["actions"];
    if (typeof actions !== "object" || actions === null || Array.isArray(actions)) return [];

    return Object.entries(actions as Record<string, unknown>).map(([actionId, spec]) => {
      const s = (typeof spec === "object" && spec !== null ? spec : {}) as Record<string, unknown>;
      return {
        actionId,
        description: typeof s["description"] === "string" ? s["description"] : undefined,
        inputSchema: s["params_schema"],
      } satisfies NwpActionDescriptor;
    });
  }

  async query(query: unknown, signal?: AbortSignal): Promise<NwpResult> {
    const descriptor = await this.getDescriptor(signal);
    if (!isQueryable(descriptor)) {
      return NwpResult.failure(S.NPS_SERVER_UNSUPPORTED, BridgeErrorCodes.SERVER_TOOL_NOT_FOUND,
        `Upstream '${this.upstream.name}' is not queryable (role: ${descriptor.role}).`);
    }
    return this.sendForResult("POST", "/query", query, signal);
  }

  invoke(actionId: string, args: unknown, async: boolean, signal?: AbortSignal): Promise<NwpResult> {
    return this.sendForResult("POST", "/invoke", { action_id: actionId, params: args ?? null, async }, signal);
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private async sendForResult(
    method: string, subPath: string, body: unknown, signal?: AbortSignal,
  ): Promise<NwpResult> {
    let res: Response;
    try {
      res = await this.send(method, subPath, body, signal);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return NwpResult.failure(S.NPS_SERVER_TIMEOUT, BridgeErrorCodes.UPSTREAM_FAILED,
          `Upstream '${this.upstream.name}' timed out.`);
      }
      return NwpResult.failure(S.NPS_DOWNSTREAM_UNAVAILABLE, BridgeErrorCodes.UPSTREAM_FAILED,
        `Upstream '${this.upstream.name}' is unreachable: ${errorMessage(e)}`);
    }

    const text = await res.text();
    if (!res.ok) {
      // Translate the upstream's status into an NPS status (NWP §16.3) rather than
      // forwarding an opaque body — that is what lets the inbound server emit a real
      // protocol-level error instead of a "successful" response carrying error text.
      return NwpResult.failure(fromHttpStatus(res.status), tryReadNwpError(text), text);
    }
    try {
      return NwpResult.success(JSON.parse(text));
    } catch (e) {
      return NwpResult.failure(S.NPS_DOWNSTREAM_UNAVAILABLE, BridgeErrorCodes.UPSTREAM_FAILED,
        `Upstream '${this.upstream.name}' returned a body that is not valid JSON: ${errorMessage(e)}`);
    }
  }

  private send(method: string, subPath: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/nwp-frame";
    if (this.upstream.agentNid) headers["X-NWP-Agent"] = this.upstream.agentNid;
    if (this.upstream.authHeader) headers["Authorization"] = this.upstream.authHeader;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    return this.fetchImpl(this.upstream.baseUrl.replace(/\/+$/, "") + subPath, init);
  }

  private unknown(): NwpNodeDescriptor {
    return { name: this.upstream.name, role: NwpNodeRole.UNKNOWN };
  }
}

/** Pull the NWP error code out of an upstream ErrorFrame body, if it carries one. */
function tryReadNwpError(body: string): string | undefined {
  try {
    const doc = JSON.parse(body) as Record<string, unknown>;
    return typeof doc?.["error"] === "string" ? doc["error"] : undefined;
  } catch {
    return undefined;
  }
}
