// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NWP Bridge Node dispatcher subsystem (NPS-2 §2A, NPS-CR-0001).
 *
 * Outbound: {@link IBridgeDispatcher} + {@link BridgeDispatcherRegistry} +
 * {@link BridgeNode} facade, with HTTP, gRPC-JSON, MCP, and A2A dispatchers.
 * Inbound: {@link McpServerBridge} / {@link A2aServerBridge} expose local NPS
 * actions to MCP/A2A clients, hosted by {@link BridgeServerApp}. The Bridge Node
 * itself is hosted by {@link BridgeNodeApp}.
 *
 * `BridgeTarget`, `BridgeProtocols`, `BridgeNodeDescriptor`, and
 * `NODE_TYPE_BRIDGE` are owned by `../bridge.js` (re-exported from the parent
 * `nwp` barrel) and are intentionally not re-declared here.
 */

export * from "./errors.js";
export { BridgeTargetParser } from "./target.js";
export { BridgeEndpointValidator } from "./endpoint-validator.js";
export {
  BridgeJsonRpc,
  BridgeJsonRpcErrorCodes,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
  type BridgeJsonRpcError,
} from "./json-rpc.js";
export { BridgeFrameJson } from "./frame-json.js";

export {
  BridgeDispatcherRegistry,
  BridgeNode,
  globalFetch,
  type IBridgeDispatcher,
  type FetchFn,
} from "./dispatcher.js";
export { HttpBridgeDispatcher } from "./http-dispatcher.js";
export { GrpcBridgeDispatcher } from "./grpc-dispatcher.js";
export {
  JsonRpcBridgeDispatcher,
  McpBridgeDispatcher,
  A2aBridgeDispatcher,
} from "./json-rpc-dispatcher.js";

export * from "./a2a-types.js";
export * from "./mcp-types.js";
export {
  toToolName,
  effectiveToolName,
  effectiveDisplayName,
  resolveServerOptions,
  BridgeServerActionInvoker,
  type BridgeServerAction,
  type BridgeServerAgentVerifier,
  type BridgeServerActionDispatcher,
  type BridgeServerOptions,
  type ResolvedBridgeServerOptions,
  type IBridgeServerActionInvoker,
} from "./server-options.js";
export { McpServerBridge } from "./mcp-server-bridge.js";
export { A2aServerBridge } from "./a2a-server-bridge.js";
export { BridgeServerApp } from "./server-app.js";
export { BridgeNodeApp, type BridgeNodeAppOptions } from "./node-app.js";
