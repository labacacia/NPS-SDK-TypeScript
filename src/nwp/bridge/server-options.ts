// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { NpsFrame } from "../../core/codec.js";
import { ErrorFrame } from "../../ncp/frames.js";
import type { ActionFrame } from "../frames.js";
import { BridgeErrorCodes } from "./errors.js";

/** Optional per-request verifier for inbound Bridge server callers. */
export type BridgeServerAgentVerifier = (
  agentNid: string,
  request: Request,
) => boolean | Promise<boolean>;

/** Dispatch delegate used by inbound Bridge server adapters. */
export type BridgeServerActionDispatcher = (frame: ActionFrame) => NpsFrame | Promise<NpsFrame>;

/** Action exposed by inbound MCP/A2A Bridge server adapters. */
export interface BridgeServerAction {
  /** NPS action identifier dispatched to the local node. */
  actionId: string;
  /** Protocol-safe MCP tool name. Defaults to a sanitized `actionId`. */
  toolName?: string;
  /** Human-readable display name for A2A AgentCard entries. */
  displayName?: string;
  /** Short action/tool description. */
  description?: string;
  /** JSON Schema describing input arguments. */
  inputSchema?: Record<string, unknown>;
  /** Whether generated `ActionFrame` values should request async execution. */
  async?: boolean;
  /** Optional A2A skill tags. */
  tags?: readonly string[];
}

/** Return a protocol-safe MCP tool name for an NPS action id. */
export function toToolName(actionId: string): string {
  if (!actionId || actionId.trim() === "") return "action";
  const chars = [...actionId.trim()].map((ch) =>
    /[A-Za-z0-9_-]/.test(ch) ? ch : "_",
  );
  const name = chars.join("").replace(/^_+|_+$/g, "");
  return name === "" ? "action" : name;
}

/** Effective MCP tool name for an action. */
export function effectiveToolName(action: BridgeServerAction): string {
  return !action.toolName || action.toolName.trim() === "" ? toToolName(action.actionId) : action.toolName;
}

/** Effective display name for A2A AgentCard skills. */
export function effectiveDisplayName(action: BridgeServerAction): string {
  return !action.displayName || action.displayName.trim() === "" ? action.actionId : action.displayName;
}

/** Options for inbound MCP/A2A Bridge server hosting. */
export interface BridgeServerOptions {
  /** Bridge server identifier surfaced in protocol metadata. */
  nodeId?: string;
  /** Path prefix for inbound Bridge server endpoints. Empty string means root. */
  pathPrefix?: string;
  /** MCP HTTP endpoint under `pathPrefix`. */
  mcpPath?: string;
  /** A2A JSON-RPC endpoint under `pathPrefix`. */
  a2aPath?: string;
  /** A2A AgentCard endpoint under `pathPrefix`. */
  a2aAgentCardPath?: string;
  /** Require a valid `X-NWP-Agent` NID header before dispatching requests. */
  requireAuth?: boolean;
  /** Verifier bound to `X-NWP-Agent`. Required when `requireAuth` is true. */
  verifyAgent?: BridgeServerAgentVerifier;
  /** Server name returned by MCP initialize and A2A AgentCard. */
  serverName?: string;
  /** Server version returned by MCP initialize and A2A AgentCard. */
  serverVersion?: string;
  /** Server description returned by A2A AgentCard. */
  description?: string;
  /** Actions exposed as MCP tools and A2A skills. */
  actions: BridgeServerAction[];
  /** Local NPS action dispatcher used by inbound Bridge server adapters. */
  dispatch?: BridgeServerActionDispatcher;
  /** Maximum inbound JSON-RPC request body size in bytes. Set to 0 to disable. */
  maxRequestBodyBytes?: number;
  /** Maximum time allowed for MCP/A2A dispatch. Set to 0 to disable. */
  dispatchTimeoutMs?: number;
}

/** Resolved defaults for `BridgeServerOptions`. */
export type ResolvedBridgeServerOptions = Required<
  Omit<BridgeServerOptions, "verifyAgent" | "dispatch" | "description">
> & Pick<BridgeServerOptions, "verifyAgent" | "dispatch" | "description">;

export function resolveServerOptions(options: BridgeServerOptions): ResolvedBridgeServerOptions {
  return {
    nodeId: options.nodeId ?? "nps-bridge-server",
    pathPrefix: options.pathPrefix ?? "",
    mcpPath: options.mcpPath ?? "/mcp",
    a2aPath: options.a2aPath ?? "/a2a",
    a2aAgentCardPath: options.a2aAgentCardPath ?? "/.well-known/agent.json",
    requireAuth: options.requireAuth ?? true,
    verifyAgent: options.verifyAgent,
    serverName: options.serverName ?? "nps-bridge-server",
    serverVersion: options.serverVersion ?? "1.0.0-alpha.15",
    description: options.description ?? "NPS Bridge server ingress.",
    actions: options.actions,
    dispatch: options.dispatch,
    maxRequestBodyBytes: options.maxRequestBodyBytes ?? 1 * 1024 * 1024,
    dispatchTimeoutMs: options.dispatchTimeoutMs ?? 30_000,
  };
}

/** Invokes local NPS actions for inbound Bridge server adapters. */
export interface IBridgeServerActionInvoker {
  invoke(frame: ActionFrame): Promise<NpsFrame>;
}

/** Default invoker that delegates to `options.dispatch`. */
export class BridgeServerActionInvoker implements IBridgeServerActionInvoker {
  constructor(private readonly options: ResolvedBridgeServerOptions) {}

  async invoke(frame: ActionFrame): Promise<NpsFrame> {
    if (this.options.dispatch === undefined) {
      return new ErrorFrame(
        "NPS-SERVER-NOT-IMPLEMENTED",
        BridgeErrorCodes.ServerDispatcherMissing,
        "BridgeServerOptions.dispatch must be configured before handling inbound Bridge calls.",
      );
    }
    return await this.options.dispatch(frame);
  }
}
