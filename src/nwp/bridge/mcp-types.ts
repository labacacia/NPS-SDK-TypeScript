// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** MCP protocol version implemented by the Bridge server adapter. */
export const McpServerProtocol = { Version: "2024-11-05" } as const;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpToolCapabilities {
  listChanged: boolean;
}

export interface McpServerCapabilities {
  tools?: McpToolCapabilities;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: McpServerCapabilities;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolListResult {
  tools: readonly McpTool[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content: readonly McpContent[];
  isError: boolean;
}
