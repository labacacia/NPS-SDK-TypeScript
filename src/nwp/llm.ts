// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { ActionFrame } from "./frames.js";

export const LLM_COMPLETE = "llm.complete" as const;
export const LLM_CONTEXT_STATUS = "llm.context.status" as const;
export const LLM_CONTEXT_RELEASE = "llm.context.release" as const;
export const LLM_COMPLETE_RESPONSE_ANCHOR = "nps:system:llm.complete:response" as const;
export const LLM_COMPLETE_STREAM_ANCHOR = "nps:system:llm.complete:stream" as const;
export const LLM_CONTEXT_STATUS_RESPONSE_ANCHOR = "nps:system:llm.context.status:response" as const;
export const LLM_CONTEXT_RELEASE_RESPONSE_ANCHOR = "nps:system:llm.context.release:response" as const;

export const CAPABILITY_LLM_COMPLETE = "llm:complete" as const;
export const CAPABILITY_LLM_CONTEXT = "llm:context" as const;
export const CAPABILITY_LLM_STREAM = "llm:stream" as const;
export const CAPABILITY_LLM_TOOL_CALL = "llm:tool_call" as const;

export type LlmStopReason = "end_turn" | "tool_use" | "tool_calls" | "max_tokens" | "length" | "error";
export type LlmContextOperation = "create" | "append" | "fork" | "reset" | "release";
export type LlmContextState = "busy" | "active" | "released" | "expired" | "failed";

export interface LlmToolCallDto {
  callId: string;
  toolName: string;
  argumentsJson: string;
}

export interface ToolParameterDto {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | string;
  description?: string;
  required: boolean;
}

export interface LlmToolDefinitionDto {
  name: string;
  description?: string;
  parameters?: readonly ToolParameterDto[];
}

export interface LlmMessageDto {
  role: "system" | "user" | "assistant" | "tool" | string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: readonly LlmToolCallDto[];
}

export interface LlmContextRequestDto {
  operation: LlmContextOperation;
  contextId?: string;
  baseVersion?: number;
  ttlSeconds?: number;
}

export interface LlmContextReceiptDto {
  contextId: string;
  version: number;
  operation: LlmContextOperation;
  state: LlmContextState;
  expiresAt?: string;
  parentContextId?: string;
  parentVersion?: number;
}

export interface LlmContextStatusRequestDto {
  contextId?: string;
  idempotencyKey?: string;
}

export interface LlmContextReleaseRequestDto {
  contextId: string;
  baseVersion: number;
}

export interface LlmContextStatusDto {
  state: LlmContextState;
  contextId?: string;
  version?: number;
  expiresAt?: string;
  requestId?: string;
  errorCode?: string;
}

export interface LlmUsageDto {
  inputTokens?: number;
  outputTokens?: number;
  cacheHit?: boolean;
  reusedTokens?: number;
  evaluatedTokens?: number;
  wireInputBytes?: number;
}

export interface LlmCompleteActionRequest {
  kind?: typeof LLM_COMPLETE;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  messages: readonly LlmMessageDto[];
  tools?: readonly LlmToolDefinitionDto[];
  context?: LlmContextRequestDto;
}

export interface LlmCompleteActionResponse {
  stopReason: LlmStopReason;
  content?: string;
  toolCalls?: readonly LlmToolCallDto[];
  error?: string;
  usage?: LlmUsageDto;
  context?: LlmContextReceiptDto;
}

export interface LlmCompleteStreamChunkDto {
  contentDelta?: string;
  toolCalls?: readonly LlmToolCallDto[];
  stopReason?: LlmStopReason;
  error?: string;
  usage?: LlmUsageDto;
  context?: LlmContextReceiptDto;
}

export interface LlmActionFrameOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
  async?: boolean;
  requestId?: string;
}

export function llmCompleteRequestToWire(request: LlmCompleteActionRequest): Record<string, unknown> {
  return compact({
    kind: LLM_COMPLETE,
    model: request.model,
    max_tokens: request.maxTokens,
    stream: request.stream ?? false,
    messages: request.messages.map(messageToWire),
    tools: request.tools?.map(toolDefinitionToWire),
    context: request.context == null ? undefined : contextRequestToWire(request.context),
  });
}

export function llmCompleteRequestFromWire(data: Record<string, unknown>): LlmCompleteActionRequest {
  const kind = data["kind"];
  if (kind !== undefined && kind !== LLM_COMPLETE) throw new TypeError("kind must be llm.complete");
  const messages = data["messages"];
  const tools = data["tools"];
  const context = data["context"];
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  if (tools !== undefined && !Array.isArray(tools)) throw new TypeError("tools must be an array");
  return {
    kind: LLM_COMPLETE,
    model: requireString(data["model"], "model"),
    maxTokens: optionalInteger(data["max_tokens"], "max_tokens"),
    stream: optionalBoolean(data["stream"], "stream") ?? false,
    messages: messages.map(value => messageFromWire(requireObject(value, "message"))),
    tools: tools?.map(value => toolDefinitionFromWire(requireObject(value, "tool"))),
    context: context == null ? undefined : contextRequestFromWire(requireObject(context, "context")),
  };
}

export function llmCompleteActionFrame(
  request: LlmCompleteActionRequest,
  options: LlmActionFrameOptions = {},
): ActionFrame {
  return new ActionFrame(
    LLM_COMPLETE,
    llmCompleteRequestToWire(request),
    options.async ?? false,
    options.idempotencyKey,
    options.timeoutMs ?? 5000,
    options.requestId,
  );
}

export function llmContextStatusActionFrame(
  request: LlmContextStatusRequestDto,
  options: Pick<LlmActionFrameOptions, "requestId"> = {},
): ActionFrame {
  return new ActionFrame(LLM_CONTEXT_STATUS, compact({
    context_id: request.contextId,
    idempotency_key: request.idempotencyKey,
  }), false, undefined, 5000, options.requestId);
}

export function llmContextReleaseActionFrame(
  request: LlmContextReleaseRequestDto,
  options: LlmActionFrameOptions & { idempotencyKey: string },
): ActionFrame {
  return new ActionFrame(LLM_CONTEXT_RELEASE, {
    context_id: request.contextId,
    base_version: request.baseVersion,
  }, false, options.idempotencyKey, options.timeoutMs ?? 5000, options.requestId);
}

export function llmCompleteResponseToWire(response: LlmCompleteActionResponse): Record<string, unknown> {
  return compact({
    stop_reason: response.stopReason,
    content: response.content,
    tool_calls: response.toolCalls?.map(toolCallToWire),
    error: response.error,
    usage: response.usage == null ? undefined : usageToWire(response.usage),
    context: response.context == null ? undefined : receiptToWire(response.context),
  });
}

export function llmCompleteResponseFromWire(data: Record<string, unknown>): LlmCompleteActionResponse {
  const stopReason = data["stop_reason"];
  if (!isStopReason(stopReason)) throw new TypeError("stop_reason is invalid");
  const toolCalls = data["tool_calls"];
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw new TypeError("tool_calls must be an array");
  }
  const usage = data["usage"];
  const context = data["context"];
  return compact({
    stopReason,
    content: optionalString(data["content"], "content"),
    toolCalls: toolCalls?.map(value => toolCallFromWire(requireObject(value, "tool_call"))),
    error: optionalString(data["error"], "error"),
    usage: usage === undefined ? undefined : usageFromWire(requireObject(usage, "usage")),
    context: context === undefined
      ? undefined
      : llmContextReceiptFromWire(requireObject(context, "context")),
  }) as unknown as LlmCompleteActionResponse;
}

export function llmContextReceiptToWire(value: LlmContextReceiptDto): Record<string, unknown> {
  return receiptToWire(value);
}

export function llmContextReceiptFromWire(value: Record<string, unknown>): LlmContextReceiptDto {
  const operation = value["operation"];
  const state = value["state"];
  if (!isContextOperation(operation)) throw new TypeError("context.operation is invalid");
  if (!isContextState(state)) throw new TypeError("context.state is invalid");
  return compact({
    contextId: requireString(value["context_id"], "context.context_id"),
    version: requireInteger(value["version"], "context.version"),
    operation,
    state,
    expiresAt: optionalString(value["expires_at"], "context.expires_at"),
    parentContextId: optionalString(value["parent_context_id"], "context.parent_context_id"),
    parentVersion: optionalInteger(value["parent_version"], "context.parent_version"),
  }) as unknown as LlmContextReceiptDto;
}

export function llmContextStatusToWire(value: LlmContextStatusDto): Record<string, unknown> {
  return compact({
    state: value.state,
    context_id: value.contextId,
    version: value.version,
    expires_at: value.expiresAt,
    request_id: value.requestId,
    error_code: value.errorCode,
  });
}

function messageToWire(value: LlmMessageDto): Record<string, unknown> {
  return compact({
    role: value.role,
    content: value.content,
    tool_call_id: value.toolCallId,
    tool_name: value.toolName,
    tool_calls: value.toolCalls?.map(toolCallToWire),
  });
}

function messageFromWire(value: Record<string, unknown>): LlmMessageDto {
  const toolCalls = value["tool_calls"];
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw new TypeError("message.tool_calls must be an array");
  }
  return compact({
    role: requireString(value["role"], "message.role"),
    content: optionalString(value["content"], "message.content"),
    toolCallId: optionalString(value["tool_call_id"], "message.tool_call_id"),
    toolName: optionalString(value["tool_name"], "message.tool_name"),
    toolCalls: toolCalls?.map(item => toolCallFromWire(requireObject(item, "message.tool_call"))),
  }) as unknown as LlmMessageDto;
}

function toolCallToWire(value: LlmToolCallDto): Record<string, unknown> {
  return { call_id: value.callId, tool_name: value.toolName, arguments_json: value.argumentsJson };
}

function toolCallFromWire(value: Record<string, unknown>): LlmToolCallDto {
  return {
    callId: requireString(value["call_id"], "tool_call.call_id"),
    toolName: requireString(value["tool_name"], "tool_call.tool_name"),
    argumentsJson: requireString(value["arguments_json"], "tool_call.arguments_json"),
  };
}

function toolDefinitionToWire(value: LlmToolDefinitionDto): Record<string, unknown> {
  return compact({
    name: value.name,
    description: value.description,
    parameters: value.parameters?.map(parameter => compact({ ...parameter })),
  });
}

function toolDefinitionFromWire(value: Record<string, unknown>): LlmToolDefinitionDto {
  const parameters = value["parameters"];
  if (parameters !== undefined && !Array.isArray(parameters)) {
    throw new TypeError("tool.parameters must be an array");
  }
  return compact({
    name: requireString(value["name"], "tool.name"),
    description: optionalString(value["description"], "tool.description"),
    parameters: parameters?.map(item => parameterFromWire(requireObject(item, "tool.parameter"))),
  }) as unknown as LlmToolDefinitionDto;
}

function parameterFromWire(value: Record<string, unknown>): ToolParameterDto {
  return {
    name: requireString(value["name"], "tool.parameter.name"),
    type: requireString(value["type"], "tool.parameter.type"),
    description: optionalString(value["description"], "tool.parameter.description"),
    required: optionalBoolean(value["required"], "tool.parameter.required") ?? false,
  };
}

function contextRequestToWire(value: LlmContextRequestDto): Record<string, unknown> {
  return compact({
    operation: value.operation,
    context_id: value.contextId,
    base_version: value.baseVersion,
    ttl_seconds: value.ttlSeconds,
  });
}

function contextRequestFromWire(value: Record<string, unknown>): LlmContextRequestDto {
  const operation = value["operation"];
  if (!isContextOperation(operation)) throw new TypeError("context.operation is invalid");
  return compact({
    operation,
    contextId: optionalString(value["context_id"], "context.context_id"),
    baseVersion: optionalInteger(value["base_version"], "context.base_version"),
    ttlSeconds: optionalInteger(value["ttl_seconds"], "context.ttl_seconds"),
  }) as unknown as LlmContextRequestDto;
}

function receiptToWire(value: LlmContextReceiptDto): Record<string, unknown> {
  return compact({
    context_id: value.contextId,
    version: value.version,
    operation: value.operation,
    state: value.state,
    expires_at: value.expiresAt,
    parent_context_id: value.parentContextId,
    parent_version: value.parentVersion,
  });
}

function usageToWire(value: LlmUsageDto): Record<string, unknown> {
  return compact({
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_hit: value.cacheHit,
    reused_tokens: value.reusedTokens,
    evaluated_tokens: value.evaluatedTokens,
    wire_input_bytes: value.wireInputBytes,
  });
}

function usageFromWire(value: Record<string, unknown>): LlmUsageDto {
  return compact({
    inputTokens: optionalInteger(value["input_tokens"], "usage.input_tokens"),
    outputTokens: optionalInteger(value["output_tokens"], "usage.output_tokens"),
    cacheHit: optionalBoolean(value["cache_hit"], "usage.cache_hit"),
    reusedTokens: optionalInteger(value["reused_tokens"], "usage.reused_tokens"),
    evaluatedTokens: optionalInteger(value["evaluated_tokens"], "usage.evaluated_tokens"),
    wireInputBytes: optionalInteger(value["wire_input_bytes"], "usage.wire_input_bytes"),
  }) as unknown as LlmUsageDto;
}

function isStopReason(value: unknown): value is LlmStopReason {
  return typeof value === "string" && [
    "end_turn", "tool_use", "tool_calls", "max_tokens", "length", "error",
  ].includes(value);
}

function isContextOperation(value: unknown): value is LlmContextOperation {
  return typeof value === "string" && ["create", "append", "fork", "reset", "release"].includes(value);
}

function isContextState(value: unknown): value is LlmContextState {
  return typeof value === "string" && ["busy", "active", "released", "expired", "failed"].includes(value);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return requireInteger(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
