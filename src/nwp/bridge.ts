// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** NWP Bridge Node type definitions (NPS-2 §2A, NPS-CR-0001). */

export const NODE_TYPE_BRIDGE = "bridge" as const;

/** Standard bridge_protocols wire-string constants (NPS-CR-0001 §3). */
export const BridgeProtocols = {
  HTTP:     "http",
  GRPC:     "grpc",
  MCP:      "mcp",
  A2A:      "a2a",
  STANDARD: ["http", "grpc", "mcp", "a2a"] as const,
} as const;

/**
 * Declares which external protocols a Bridge Node bridges, in each direction.
 *
 * - `supportedProtocols` → `Announce.bridge_protocols` (OUTBOUND: NPS → external)
 * - `inboundProtocols` → `Announce.bridge_inbound_protocols` (INBOUND: external → NPS)
 *
 * Omitting `inboundProtocols` means the node exposes no inbound surface — an
 * outbound-only Bridge Node, the only kind that existed through alpha.15. A Bridge Node
 * MUST have at least one of the two non-empty. (NPS-CR-0010)
 */
export interface BridgeNodeDescriptor {
  nid: string;
  supportedProtocols: ReadonlySet<string> | string[];
  inboundProtocols?: ReadonlySet<string> | string[];
}

/** Inbound parameter object for a bridge invocation. */
export interface BridgeTarget {
  protocol: string;
  endpoint: string;
  extras?:  Record<string, unknown>;
}

export function bridgeTargetToDict(t: BridgeTarget): Record<string, unknown> {
  const d: Record<string, unknown> = { protocol: t.protocol, endpoint: t.endpoint };
  if (t.extras !== undefined) d["extras"] = t.extras;
  return d;
}

export function bridgeTargetFromDict(d: Record<string, unknown>): BridgeTarget {
  return {
    protocol: d["protocol"] as string,
    endpoint: d["endpoint"] as string,
    extras:   d["extras"] !== undefined ? d["extras"] as Record<string, unknown> : undefined,
  };
}
