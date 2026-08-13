// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** Action Server coordinator for the NWP 0.21 stateful LLM context contract. */

import { NpsStatusCodes, toHttpStatus, type NpsStatusCode } from "../core/status-codes.js";
import {
  ActionExecutionError,
  type ActionContext,
  type ActionExecutionResult,
  type ActionNodeOptions,
  type IActionNodeProvider,
} from "./action-server.js";
import {
  InMemoryLlmContextStore,
  LlmContextStoreError,
  type LlmContextBinding,
  type LlmContextMutationReservation,
  type LlmContextOwner,
} from "./context-store.js";
import type { ActionFrame } from "./frames.js";
import {
  CAPABILITY_LLM_COMPLETE,
  CAPABILITY_LLM_CONTEXT,
  LLM_COMPLETE,
  LLM_COMPLETE_RESPONSE_ANCHOR,
  LLM_CONTEXT_RELEASE,
  LLM_CONTEXT_RELEASE_RESPONSE_ANCHOR,
  LLM_CONTEXT_STATUS,
  LLM_CONTEXT_STATUS_RESPONSE_ANCHOR,
  llmCompleteRequestFromWire,
  llmCompleteResponseFromWire,
  llmCompleteResponseToWire,
  llmContextReceiptToWire,
  llmContextStatusToWire,
  type LlmCompleteActionRequest,
  type LlmContextOperation,
  type LlmMessageDto,
} from "./llm.js";
import * as ErrorCodes from "./nwp-error-codes.js";

export const LLM_COMPLETE_REQUEST_ANCHOR = "nps:system:llm.complete:request" as const;
export const LLM_CONTEXT_STATUS_REQUEST_ANCHOR = "nps:system:llm.context.status:request" as const;
export const LLM_CONTEXT_RELEASE_REQUEST_ANCHOR = "nps:system:llm.context.release:request" as const;

export type LlmAuthorizationStage = "admission" | "commit";

export type LlmContextAuthorizer = (
  owner: LlmContextOwner,
  actionId: string,
  stage: LlmAuthorizationStage,
  context: ActionContext,
  signal?: AbortSignal,
) => Promise<void> | void;

export interface StatefulLlmActionOptions {
  /** Deployment-authenticated tenant/workspace scope; never read from payloads. */
  securityScope: string;
  /** Provider/runtime compatibility revision included in immutable bindings. */
  runtimeRevision: string;
  providerName?: string;
  defaultModel?: string;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  reasoningVisibility?: string;
  authorizer?: LlmContextAuthorizer;
}

/** Wraps an ordinary LLM provider with the official context lifecycle state machine. */
export class StatefulLlmActionProvider implements IActionNodeProvider {
  readonly store: InMemoryLlmContextStore;
  private readonly options: Required<Pick<StatefulLlmActionOptions,
    "supportsTools" | "supportsJsonMode">> & StatefulLlmActionOptions;

  constructor(
    private readonly inner: IActionNodeProvider,
    store: InMemoryLlmContextStore,
    options: StatefulLlmActionOptions,
  ) {
    if (!options.securityScope.trim()) throw new Error("securityScope must not be empty");
    if (!options.runtimeRevision.trim()) throw new Error("runtimeRevision must not be empty");
    this.store = store;
    this.options = { supportsTools: false, supportsJsonMode: false, ...options };
  }

  /** Registers the exact actions and process-persistence profile implemented here. */
  configureNode(node: ActionNodeOptions): void {
    const current = node.actions[LLM_COMPLETE];
    node.actions[LLM_COMPLETE] = {
      description: current?.description ?? "Complete an LLM request",
      paramsAnchor: LLM_COMPLETE_REQUEST_ANCHOR,
      resultAnchor: LLM_COMPLETE_RESPONSE_ANCHOR,
      async: current?.async ?? true,
      idempotent: true,
      timeoutMsDefault: current?.timeoutMsDefault,
      timeoutMsMax: current?.timeoutMsMax,
      requiredCapability: CAPABILITY_LLM_COMPLETE,
    };
    node.actions[LLM_CONTEXT_STATUS] = {
      description: "Inspect an LLM context or retained create outcome",
      paramsAnchor: LLM_CONTEXT_STATUS_REQUEST_ANCHOR,
      resultAnchor: LLM_CONTEXT_STATUS_RESPONSE_ANCHOR,
      requiredCapability: CAPABILITY_LLM_CONTEXT,
    };
    node.actions[LLM_CONTEXT_RELEASE] = {
      description: "Release an LLM context",
      paramsAnchor: LLM_CONTEXT_RELEASE_REQUEST_ANCHOR,
      resultAnchor: LLM_CONTEXT_RELEASE_RESPONSE_ANCHOR,
      idempotent: true,
      requiredCapability: CAPABILITY_LLM_CONTEXT,
    };

    const descriptor = this.store.descriptor;
    const profile: Record<string, unknown> = {
      profile_version: "0.2",
      actions: [LLM_COMPLETE, LLM_CONTEXT_STATUS, LLM_CONTEXT_RELEASE],
      supports_stream: false,
      supports_tools: this.options.supportsTools,
      supports_json_mode: this.options.supportsJsonMode,
      context: {
        supported: true,
        operations: descriptor.operations,
        persistence: descriptor.persistence,
        max_contexts_per_principal: descriptor.maxContextsPerPrincipal,
        max_ttl_seconds: descriptor.maxTtlSeconds,
        tombstone_seconds: descriptor.tombstoneSeconds,
      },
    };
    if (this.options.providerName !== undefined) profile["provider"] = this.options.providerName;
    if (this.options.defaultModel !== undefined) profile["default_model"] = this.options.defaultModel;
    if (this.options.reasoningVisibility !== undefined) {
      profile["reasoning_visibility"] = this.options.reasoningVisibility;
    }
    node.profiles = { ...node.profiles, llm: profile };
  }

  async authorize(frame: ActionFrame, context: ActionContext, signal?: AbortSignal): Promise<void> {
    await this.inner.authorize?.(frame, context, signal);
    const contextAction = frame.actionId === LLM_CONTEXT_STATUS || frame.actionId === LLM_CONTEXT_RELEASE ||
      (frame.actionId === LLM_COMPLETE && hasContextRequest(frame.params));
    if (!contextAction) return;
    const owner = this.owner(context);
    await this.options.authorizer?.(owner, frame.actionId, "admission", context, signal);
  }

  async execute(
    frame: ActionFrame,
    context: ActionContext,
    signal?: AbortSignal,
  ): Promise<ActionExecutionResult> {
    if (frame.actionId === LLM_COMPLETE) return this.complete(frame, context, signal);
    if (frame.actionId === LLM_CONTEXT_STATUS) return this.status(frame, context);
    if (frame.actionId === LLM_CONTEXT_RELEASE) return this.release(frame, context);
    return this.inner.execute(frame, context, signal);
  }

  private async complete(
    frame: ActionFrame,
    context: ActionContext,
    signal?: AbortSignal,
  ): Promise<ActionExecutionResult> {
    const request = parseCompleteRequest(frame.params);
    if (!this.options.supportsTools && (request.tools?.length ?? 0) > 0) {
      throw paramsError("this node does not advertise LLM tool-definition support");
    }
    if (request.context === undefined) return this.inner.execute(frame, context, signal);
    if (request.stream) {
      throw paramsError("the Action Server context coordinator supports unary/async completion, not streaming");
    }
    if (["append", "fork", "reset"].includes(request.context.operation)
      && (request.context.contextId === undefined || request.context.baseVersion === undefined)) {
      throw paramsError("append/fork/reset require context_id and base_version");
    }

    const owner = this.owner(context);
    const reservation = this.reserve(owner, request, frame);
    let providerResult: ActionExecutionResult;
    try {
      providerResult = await this.inner.execute(frame, context, signal);
      if (signal?.aborted) throw new Error("action execution cancelled");
    } catch (error) {
      this.abort(reservation, error instanceof ActionExecutionError
        ? error.errorCode
        : ErrorCodes.NWP_NODE_UNAVAILABLE);
      throw error;
    }

    let response;
    try {
      if (!isObject(providerResult.result)) throw new TypeError("result must be an object");
      response = llmCompleteResponseFromWire(providerResult.result);
    } catch (error) {
      this.abort(reservation, ErrorCodes.NWP_NODE_UNAVAILABLE);
      throw internalError(`stateful llm.complete returned an invalid official response: ${errorMessage(error)}`);
    }
    if (response.stopReason === "error") {
      this.abort(reservation, ErrorCodes.NWP_NODE_UNAVAILABLE);
      return completionResult({ ...response, context: undefined }, providerResult);
    }

    try {
      await this.options.authorizer?.(owner, frame.actionId, "commit", context, signal);
      if (signal?.aborted) throw new Error("action execution cancelled");
    } catch (error) {
      this.abort(reservation, error instanceof ActionExecutionError
        ? error.errorCode
        : ErrorCodes.NWP_NODE_UNAVAILABLE);
      throw error;
    }

    const assistant: LlmMessageDto = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    };
    try {
      const receipt = this.store.commit(reservation, assistant);
      return completionResult({ ...response, context: receipt }, providerResult);
    } catch (error) {
      if (error instanceof LlmContextStoreError) throw mapStoreError(error);
      throw error;
    }
  }

  private status(frame: ActionFrame, context: ActionContext): ActionExecutionResult {
    const params = requireParams(frame.params, LLM_CONTEXT_STATUS);
    const contextId = optionalString(params["context_id"], "context_id");
    const idempotencyKey = optionalString(params["idempotency_key"], "idempotency_key");
    try {
      const status = this.store.status(this.owner(context), { contextId, idempotencyKey });
      return { result: llmContextStatusToWire(status), anchorRef: LLM_CONTEXT_STATUS_RESPONSE_ANCHOR };
    } catch (error) {
      if (error instanceof LlmContextStoreError) throw mapStoreError(error);
      throw error;
    }
  }

  private release(frame: ActionFrame, context: ActionContext): ActionExecutionResult {
    const params = requireParams(frame.params, LLM_CONTEXT_RELEASE);
    const contextId = requiredString(params["context_id"], "context_id");
    const baseVersion = requiredInteger(params["base_version"], "base_version");
    try {
      const receipt = this.store.release(
        this.owner(context), contextId, baseVersion, frame.idempotencyKey ?? "",
      );
      return {
        result: llmContextReceiptToWire(receipt),
        anchorRef: LLM_CONTEXT_RELEASE_RESPONSE_ANCHOR,
      };
    } catch (error) {
      if (error instanceof LlmContextStoreError) throw mapStoreError(error);
      throw error;
    }
  }

  private reserve(
    owner: LlmContextOwner,
    request: LlmCompleteActionRequest,
    frame: ActionFrame,
  ): LlmContextMutationReservation {
    const context = request.context!;
    let binding: LlmContextBinding;
    if (context.operation === "append" || context.operation === "fork") {
      if (context.contextId === undefined) throw paramsError("append/fork require context_id and base_version");
      try {
        const snapshot = this.store.snapshot(owner, context.contextId);
        binding = {
          model: request.model,
          systemMessages: snapshot.binding.systemMessages,
          tools: request.tools ?? snapshot.binding.tools,
          runtimeRevision: this.options.runtimeRevision,
        };
      } catch (error) {
        if (error instanceof LlmContextStoreError) throw mapStoreError(error);
        throw error;
      }
    } else {
      binding = {
        model: request.model,
        systemMessages: request.messages.filter(message => message.role.toLowerCase() === "system"),
        tools: request.tools,
        runtimeRevision: this.options.runtimeRevision,
      };
    }
    try {
      return this.store.reserve({
        operation: context.operation,
        owner,
        contextId: context.contextId,
        baseVersion: context.baseVersion,
        binding,
        messages: request.messages,
        ttlSeconds: context.ttlSeconds,
        idempotencyKey: frame.idempotencyKey ?? "",
        requestId: frame.requestId ?? "",
      });
    } catch (error) {
      if (error instanceof LlmContextStoreError) throw mapStoreError(error);
      throw error;
    }
  }

  private owner(context: ActionContext): LlmContextOwner {
    if (!context.agentNid?.trim()) {
      throw new ActionExecutionError(
        401,
        NpsStatusCodes.NPS_AUTH_UNAUTHENTICATED,
        ErrorCodes.NWP_AUTH_NID_SCOPE_VIOLATION,
        "stateful LLM context actions require an authenticated agent NID",
      );
    }
    return { nid: context.agentNid, securityScope: this.options.securityScope };
  }

  private abort(reservation: LlmContextMutationReservation, errorCode: string): void {
    try {
      this.store.abort(reservation, errorCode);
    } catch (error) {
      throw internalError(`failed to abort LLM context reservation: ${errorMessage(error)}`);
    }
  }
}

function parseCompleteRequest(params: Record<string, unknown> | undefined): LlmCompleteActionRequest {
  const wire = requireParams(params, LLM_COMPLETE);
  if (typeof wire["model"] !== "string" || !wire["model"].trim()) {
    throw paramsError("llm.complete requires a non-empty model");
  }
  if (!Array.isArray(wire["messages"])) throw paramsError("messages must be an array");
  for (const message of wire["messages"]) {
    if (!isObject(message) || typeof message["role"] !== "string") {
      throw paramsError("each message requires a string role");
    }
  }
  const context = wire["context"];
  if (context !== undefined) {
    if (!isObject(context) || !isContextOperation(context["operation"])) {
      throw paramsError("context.operation is invalid");
    }
  }
  try {
    return llmCompleteRequestFromWire(wire);
  } catch (error) {
    throw paramsError(errorMessage(error));
  }
}

function completionResult(
  response: Parameters<typeof llmCompleteResponseToWire>[0],
  providerResult: ActionExecutionResult,
): ActionExecutionResult {
  return {
    result: llmCompleteResponseToWire(response),
    anchorRef: providerResult.anchorRef ?? LLM_COMPLETE_RESPONSE_ANCHOR,
    tokenEst: providerResult.tokenEst,
  };
}

function requireParams(
  params: Record<string, unknown> | undefined,
  actionId: string,
): Record<string, unknown> {
  if (!isObject(params)) throw paramsError(`${actionId} requires an object params payload`);
  return params;
}

function hasContextRequest(params: Record<string, unknown> | undefined): boolean {
  return isObject(params) && params["context"] !== undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextOperation(value: unknown): value is LlmContextOperation {
  return typeof value === "string" && ["create", "append", "fork", "reset", "release"].includes(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw paramsError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name);
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw paramsError(`${name} must be an integer`);
  return value;
}

function paramsError(message: string): ActionExecutionError {
  return new ActionExecutionError(
    422,
    NpsStatusCodes.NPS_CLIENT_UNPROCESSABLE,
    ErrorCodes.NWP_ACTION_PARAMS_INVALID,
    message,
  );
}

function internalError(message: string): ActionExecutionError {
  return new ActionExecutionError(
    500,
    NpsStatusCodes.NPS_SERVER_INTERNAL,
    ErrorCodes.NWP_NODE_UNAVAILABLE,
    message,
  );
}

function mapStoreError(error: LlmContextStoreError): ActionExecutionError {
  const status = (ErrorCodes.NWP_ERROR_TO_NPS_STATUS[error.errorCode] ??
    NpsStatusCodes.NPS_SERVER_INTERNAL) as NpsStatusCode;
  return new ActionExecutionError(toHttpStatus(status), status, error.errorCode, error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
