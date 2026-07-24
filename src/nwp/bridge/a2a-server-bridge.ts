// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { NpsFrame } from "../../core/codec.js";
import { ErrorFrame } from "../../ncp/frames.js";
import { ActionFrame } from "../frames.js";
import { BridgeErrorCodes } from "./errors.js";
import { BridgeFrameJson } from "./frame-json.js";
import {
  BridgeJsonRpc,
  BridgeJsonRpcErrorCodes,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import {
  A2aTaskState,
  type A2aAgentCard,
  type A2aSendTaskParams,
  type A2aTask,
} from "./a2a-types.js";
import {
  effectiveDisplayName,
  effectiveToolName,
  type BridgeServerAction,
  type IBridgeServerActionInvoker,
  type ResolvedBridgeServerOptions,
} from "./server-options.js";

/** Inbound A2A adapter that exposes local NPS actions as A2A skills. */
export class A2aServerBridge {
  constructor(
    private readonly options: ResolvedBridgeServerOptions,
    private readonly invoker: IBridgeServerActionInvoker,
  ) {}

  /** Build the A2A AgentCard for the hosted Bridge server. */
  buildAgentCard(endpointUrl: string): A2aAgentCard {
    const card: A2aAgentCard = {
      name: this.options.serverName,
      description: this.options.description,
      url: endpointUrl,
      provider: {
        organization: "LabAcacia / INNO LOTUS PTY LTD",
        url: "https://github.com/labacacia/nps",
      },
      version: this.options.serverVersion,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ["text", "data"],
      defaultOutputModes: ["text", "data"],
      skills: this.options.actions.map((action) => ({
        id: action.actionId,
        name: effectiveDisplayName(action),
        description: action.description,
        tags: action.tags,
        inputModes: ["text", "data"],
        outputModes: ["data"],
      })),
    };

    if (this.options.requireAuth) {
      card.authentication = { schemes: ["apikey"], credentials: "X-NWP-Agent" };
    }
    return card;
  }

  /** Dispatch one A2A JSON-RPC request. */
  async dispatch(request: BridgeJsonRpcRequest): Promise<BridgeJsonRpcResponse> {
    if (request.method === "tasks/send") {
      return await this.sendTask(request);
    }
    return BridgeJsonRpc.error(
      request,
      BridgeJsonRpcErrorCodes.MethodNotFound,
      `A2A method '${request.method}' is not supported by NWP Bridge server.`,
    );
  }

  private async sendTask(request: BridgeJsonRpcRequest): Promise<BridgeJsonRpcResponse> {
    if (request.params === undefined || request.params === null) {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.InvalidParams,
        "A2A tasks/send requires params.",
      );
    }

    const task = request.params as A2aSendTaskParams;
    if (task == null || !task.id || task.id.trim() === "") {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.InvalidParams,
        "A2A tasks/send params.id is required.",
      );
    }

    const action = this.resolveAction(task);
    if (action === undefined) {
      return BridgeJsonRpc.error(
        request,
        BridgeJsonRpcErrorCodes.InvalidParams,
        "A2A task metadata must identify an exposed NPS action when multiple actions exist.",
        { error: BridgeErrorCodes.ServerToolNotFound },
      );
    }

    const frame = new ActionFrame(
      action.actionId,
      extractActionParams(task) ?? undefined,
      action.async ?? false,
      task.id,
    );

    try {
      const result = await this.invoker.invoke(frame);
      return BridgeJsonRpc.success(request, toTask(task, result));
    } catch (err) {
      return BridgeJsonRpc.success(
        request,
        toTask(
          task,
          new ErrorFrame(
            "NPS-SERVER-ERROR",
            BridgeErrorCodes.ServerDispatchFailed,
            err instanceof Error ? err.message : String(err),
          ),
        ),
      );
    }
  }

  private resolveAction(task: A2aSendTaskParams): BridgeServerAction | undefined {
    let requested =
      firstNonEmpty(
        tryGetString(task.metadata, "action_id", "actionId", "skill_id", "skillId", "skill"),
        tryGetString(task.message.metadata, "action_id", "actionId", "skill_id", "skillId", "skill"),
      );

    if (isEmpty(requested)) {
      for (const part of task.message.parts) {
        requested = firstNonEmpty(
          tryGetString(part.metadata, "action_id", "actionId", "skill_id", "skillId", "skill"),
          tryGetString(part.data, "action_id", "actionId", "skill_id", "skillId", "skill"),
        );
        if (!isEmpty(requested)) break;
      }
    }

    if (isEmpty(requested) && this.options.actions.length === 1) return this.options.actions[0];

    return this.options.actions.find(
      (action) =>
        action.actionId.toLowerCase() === (requested ?? "").toLowerCase() ||
        effectiveToolName(action).toLowerCase() === (requested ?? "").toLowerCase(),
    );
  }
}

function extractActionParams(task: A2aSendTaskParams): Record<string, unknown> | null {
  const fromMetadata =
    tryGetElement(task.metadata, "params", "arguments") ??
    tryGetElement(task.message.metadata, "params", "arguments");
  if (fromMetadata !== undefined) return fromMetadata as Record<string, unknown>;

  for (const part of task.message.parts) {
    const nested = tryGetElement(part.data, "params", "arguments");
    if (nested !== undefined) return nested as Record<string, unknown>;

    if (part.type.toLowerCase() === "data" && part.data !== undefined && part.data !== null) {
      return part.data as Record<string, unknown>;
    }

    if (part.type.toLowerCase() === "text" && part.text != null && part.text.trim() !== "") {
      return { text: part.text };
    }
  }

  return null;
}

function toTask(request: A2aSendTaskParams, frame: NpsFrame): A2aTask {
  const isError = frame instanceof ErrorFrame;
  const timestamp = new Date().toISOString();
  const payload = BridgeFrameJson.toElement(frame);

  const task: A2aTask = {
    id: request.id,
    status: {
      state: isError ? A2aTaskState.Failed : A2aTaskState.Completed,
      timestamp,
      message: isError
        ? {
            role: "agent",
            parts: [
              {
                type: "text",
                text:
                  frame instanceof ErrorFrame
                    ? frame.message ?? frame.error
                    : "NPS action failed.",
              },
            ],
          }
        : undefined,
    },
    artifacts: [
      {
        name: isError ? "nps-error" : "nps-result",
        parts: [{ type: "data", data: payload }],
        index: 0,
      },
    ],
    history: [request.message],
  };
  if (request.sessionId !== undefined) task.sessionId = request.sessionId;
  return task;
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function isObject(source: unknown): source is Record<string, unknown> {
  return typeof source === "object" && source !== null && !Array.isArray(source);
}

function tryGetElement(source: unknown, ...names: string[]): unknown {
  if (!isObject(source)) return undefined;
  for (const name of names) {
    if (name in source) return source[name];
  }
  return undefined;
}

function tryGetString(source: unknown, ...names: string[]): string | undefined {
  const value = tryGetElement(source, ...names);
  return typeof value === "string" ? value : undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}
