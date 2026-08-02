// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport-independent configuration of a Bridge Node's inbound surface
 * (NWP §2.1 inbound profile, NPS-CR-0010).
 *
 * This type deliberately knows nothing about HTTP: the protocol servers
 * ({@link McpInboundServer}, {@link A2aInboundServer}, {@link GrpcInboundService}) are
 * written against it alone. The hosting concerns — paths, a request-bound auth verifier,
 * body limits — live in `BridgeServerOptions` (see `host.ts`), which extends this. Keeping
 * the servers off the derived type means they never touch a `Request`, so they can be driven
 * over stdio or from a unit test with no web host at all.
 */

import { VERSION } from "../../index.js";
import {
  HttpNwpBackend,
  InProcessNwpBackend,
  NwpNodeRole,
  type FetchLike,
  type INwpBackend,
  type NwpActionDescriptor,
  type NwpInProcessActionDispatcher,
  type NwpInProcessQueryDispatcher,
  type NwpUpstream,
} from "./backend.js";

/** An action exposed by an inbound Bridge server as an MCP tool / A2A skill. */
export interface BridgeServerAction {
  actionId: string;
  /** Display name for A2A AgentCard entries. Falls back to {@link actionId}. */
  displayName?: string;
  description?: string;
  inputSchema?: unknown;
  /** Whether generated ActionFrames should request async execution. */
  async?: boolean;
  /** Optional A2A skill tags. */
  tags?: readonly string[];
}

export interface BridgeInboundOptions {
  /** Identifier of the co-hosted node. Namespaces its MCP resource URIs and tool names. */
  nodeId?: string;
  /** Server name returned by MCP `initialize` and the A2A AgentCard. */
  serverName?: string;
  /** Server version returned by MCP `initialize` and the A2A AgentCard. */
  serverVersion?: string;
  /** Server description returned by the A2A AgentCard. */
  description?: string;
  /**
   * Role of the co-hosted node projected by the in-process backend. Defaults to
   * {@link NwpNodeRole.ACTION} — the only shape the pre-CR-0010 Bridge server supported.
   * Set to COMPLEX or MEMORY together with {@link query} to project resources as well as tools.
   */
  nodeRole?: NwpNodeRole;
  /** Actions exposed as MCP tools and A2A skills. */
  actions?: readonly BridgeServerAction[];
  /** Local NPS action dispatcher. Required for a co-hosted invokable node. */
  dispatch?: NwpInProcessActionDispatcher;
  /**
   * Local NPS query dispatcher. Set this to project a co-hosted Memory / Complex Node onto
   * the inbound protocol's read surface (MCP `resources/*`). Leaving it unset is conformant —
   * the resource methods are still served, over an empty set (NWP §16.1.2).
   */
  query?: NwpInProcessQueryDispatcher;
  /** Remote NWP nodes this Bridge fronts over HTTP. May be combined with a co-hosted node. */
  upstreams?: readonly NwpUpstream[];
  /** Max rows a single MCP `resources/read` may pull from a Memory Node. */
  resourceReadLimit?: number;
  /**
   * External protocols this Bridge Node **serves inbound**, announced as NDP
   * `bridge_inbound_protocols` (NPS-4 §3.1). A request for a protocol absent from this set
   * MUST be rejected with `NWP-BRIDGE-DIRECTION-UNSUPPORTED` (NWP §16.1.2 MUST-5).
   *
   * Default `["mcp", "a2a"]` — note gRPC is **not** in the default set, so the gRPC service
   * refuses until `"grpc"` is added.
   */
  inboundProtocols?: readonly string[];
  /**
   * External protocols this Bridge Node dispatches **outbound** (`bridge_protocols`). Carried
   * here only so a `NWP-BRIDGE-DIRECTION-UNSUPPORTED` response can name both declared arrays
   * in its `hint` (§16.1.2 MUST-5 SHOULD-clause).
   */
  outboundProtocols?: readonly string[];
  /**
   * Whether this Bridge Node requires an authenticated caller. Advertised on the A2A
   * AgentCard, so it is part of the inbound protocol surface, not merely host configuration.
   */
  requireAuth?: boolean;
}

export const BRIDGE_INBOUND_DEFAULTS = {
  nodeId: "nps-bridge-server",
  serverName: "nps-bridge-server",
  serverVersion: VERSION,
  description: "NPS Bridge Node inbound surface.",
  nodeRole: NwpNodeRole.ACTION,
  resourceReadLimit: 100,
  inboundProtocols: ["mcp", "a2a"] as readonly string[],
  requireAuth: true,
} as const;

/** Options with every default filled in. Protocol servers work against this. */
export type ResolvedBridgeInboundOptions =
  Required<Pick<BridgeInboundOptions,
    "nodeId" | "serverName" | "serverVersion" | "nodeRole" | "resourceReadLimit"
    | "inboundProtocols" | "requireAuth" | "actions">>
  & BridgeInboundOptions;

export function resolveBridgeInboundOptions(o: BridgeInboundOptions = {}): ResolvedBridgeInboundOptions {
  return {
    ...o,
    nodeId:            o.nodeId            ?? BRIDGE_INBOUND_DEFAULTS.nodeId,
    serverName:        o.serverName        ?? BRIDGE_INBOUND_DEFAULTS.serverName,
    serverVersion:     o.serverVersion     ?? BRIDGE_INBOUND_DEFAULTS.serverVersion,
    description:       o.description       ?? BRIDGE_INBOUND_DEFAULTS.description,
    nodeRole:          o.nodeRole          ?? BRIDGE_INBOUND_DEFAULTS.nodeRole,
    resourceReadLimit: o.resourceReadLimit ?? BRIDGE_INBOUND_DEFAULTS.resourceReadLimit,
    inboundProtocols:  o.inboundProtocols  ?? BRIDGE_INBOUND_DEFAULTS.inboundProtocols,
    requireAuth:       o.requireAuth       ?? BRIDGE_INBOUND_DEFAULTS.requireAuth,
    actions:           o.actions           ?? [],
  };
}

/** Whether this Bridge Node declares `protocol` on its inbound surface (case-insensitive). */
export function servesInbound(o: ResolvedBridgeInboundOptions, protocol: string): boolean {
  return o.inboundProtocols.some((p) => p.toLowerCase() === protocol.toLowerCase());
}

/**
 * The two declared protocol arrays, for the `hint` of a
 * `NWP-BRIDGE-DIRECTION-UNSUPPORTED` response. §16.1.2 MUST-5's SHOULD-clause asks for both;
 * the .NET implementation omits them, and this port adds them (TC-N2-BridgeIn-06 pass 2).
 */
export function directionHint(o: ResolvedBridgeInboundOptions): Record<string, unknown> {
  return {
    bridge_inbound_protocols: [...o.inboundProtocols],
    bridge_protocols: [...(o.outboundProtocols ?? [])],
  };
}

/**
 * Materialise the {@link INwpBackend} set an inbound Bridge server serves. Both shapes are
 * supported and may be combined.
 *
 * Note the `actions` check: a deployment that declares actions but forgets the dispatcher
 * still gets an in-process backend, so its tools appear in `tools/list` and a call fails
 * loudly with `NWP-BRIDGE-SERVER-DISPATCHER-MISSING`. Omitting the backend instead would make
 * a misconfiguration look like "this node simply exposes nothing".
 */
export function createBridgeServerBackends(
  options: BridgeInboundOptions,
  fetchImpl?: FetchLike,
): INwpBackend[] {
  const o = resolveBridgeInboundOptions(options);
  const backends: INwpBackend[] = [];

  if (o.dispatch !== undefined || o.query !== undefined || o.actions.length > 0) {
    const actions: NwpActionDescriptor[] = o.actions.map((a) => ({
      actionId:    a.actionId,
      description: a.description,
      inputSchema: a.inputSchema,
      async:       a.async ?? false,
      tags:        a.tags,
    }));
    backends.push(new InProcessNwpBackend(
      {
        name:        o.nodeId,
        role:        o.nodeRole,
        displayName: o.serverName,
        description: o.description,
      },
      actions,
      o.dispatch,
      o.query,
    ));
  }

  const upstreams = o.upstreams ?? [];
  if (upstreams.length > 0) {
    if (fetchImpl === undefined && typeof fetch !== "function") {
      throw new Error(
        "BridgeInboundOptions.upstreams is non-empty but no fetch implementation is available. " +
        "An HTTP-fronted Bridge Node needs one to reach its upstream nodes.",
      );
    }
    for (const upstream of upstreams) backends.push(new HttpNwpBackend(upstream, fetchImpl));
  }

  return backends;
}
