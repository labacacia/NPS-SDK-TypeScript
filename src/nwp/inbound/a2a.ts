// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound **A2A** server surface of a Bridge Node (NWP §2.1 inbound profile, §16.1.2).
 * Projects the Action / Complex Nodes behind one or more {@link INwpBackend} instances onto
 * A2A skills. Only one JSON-RPC method is served: `tasks/send`.
 */

import { NpsStatusCodes } from "../../core/status-codes.js";
import {
  isInvokable,
  type INwpBackend,
  type NwpActionDescriptor,
  type NwpNodeDescriptor,
  type NwpResult,
} from "./backend.js";
import { BridgeErrorCodes, mustBeProtocolError, toJsonRpc } from "./error-map.js";
import {
  BridgeJsonRpcErrorCodes,
  jsonRpcError,
  jsonRpcSuccess,
  type BridgeJsonRpcRequest,
  type BridgeJsonRpcResponse,
} from "./json-rpc.js";
import { McpToolName } from "./mcp.js";
import {
  directionHint,
  resolveBridgeInboundOptions,
  servesInbound,
  type BridgeInboundOptions,
  type ResolvedBridgeInboundOptions,
} from "./options.js";

// ── AgentCard / task wire types ──────────────────────────────────────────────

export interface A2aAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: readonly string[];
  inputModes: readonly string[];
  outputModes: readonly string[];
}

export interface A2aAgentCard {
  name: string;
  description?: string;
  url: string;
  provider: { organization: string; url: string };
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  authentication: { schemes: string[]; credentials: string } | null;
  skills: A2aAgentSkill[];
}

export interface A2aPart {
  type: string;
  text?: string;
  data?: unknown;
  metadata?: unknown;
}

export interface A2aMessage {
  role: string;
  parts?: readonly A2aPart[];
  metadata?: unknown;
}

export interface A2aSendTaskParams {
  id: string;
  sessionId?: string;
  message: A2aMessage;
  metadata?: unknown;
}

/** Skill-identifying metadata keys, searched in this exact order. */
const SKILL_KEYS = ["action_id", "actionId", "skill_id", "skillId", "skill"] as const;
/** Argument-carrying metadata keys, searched in this exact order. */
const PARAM_KEYS = ["params", "arguments"] as const;

export class A2aInboundServer {
  private readonly options: ResolvedBridgeInboundOptions;

  constructor(
    options: BridgeInboundOptions,
    private readonly backends: readonly INwpBackend[],
  ) {
    this.options = resolveBridgeInboundOptions(options);
  }

  /**
   * Build the A2A AgentCard advertising every skill this Bridge Node fronts.
   * Served at `/.well-known/agent.json`.
   */
  async buildAgentCard(endpointUrl: string, signal?: AbortSignal): Promise<A2aAgentCard> {
    const skills: A2aAgentSkill[] = [];
    for (const { backend, descriptor } of await this.invokableBackends(signal)) {
      for (const action of await backend.getActions(signal)) {
        skills.push({
          // Qualified names, exactly as tools/list emits them.
          id: McpToolName.encode(descriptor.name, action.actionId),
          name: action.description ?? action.actionId,
          description: action.description,
          tags: action.tags,
          inputModes: ["text", "data"],
          outputModes: ["data"],
        });
      }
    }

    return {
      name: this.options.serverName,
      description: this.options.description,
      url: endpointUrl,
      provider: {
        organization: "LabAcacia / INNO LOTUS PTY LTD",
        url: "https://github.com/labacacia/nps",
      },
      version: this.options.serverVersion,
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      // RequireAuth is advertised here, so it is part of the protocol surface, not merely
      // host configuration.
      authentication: this.options.requireAuth
        ? { schemes: ["apikey"], credentials: "X-NWP-Agent" }
        : null,
      skills,
    };
  }

  /** Dispatch one A2A JSON-RPC request. */
  async dispatch(request: BridgeJsonRpcRequest, signal?: AbortSignal): Promise<BridgeJsonRpcResponse> {
    if (request === null || request === undefined) throw new TypeError("request is required");

    // §16.1.2 MUST-5.
    if (!servesInbound(this.options, "a2a")) {
      return jsonRpcError(request,
        toJsonRpc(NpsStatusCodes.NPS_SERVER_UNSUPPORTED),
        'This Bridge Node does not declare "a2a" in bridge_inbound_protocols.',
        { error: BridgeErrorCodes.DIRECTION_UNSUPPORTED, hint: directionHint(this.options) });
    }

    if (request.method !== "tasks/send") {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.METHOD_NOT_FOUND,
        `A2A method '${request.method}' is not supported by this Bridge Node.`,
        { error: BridgeErrorCodes.DIRECTION_UNSUPPORTED, hint: directionHint(this.options) });
    }

    return this.sendTask(request, signal);
  }

  private async sendTask(
    request: BridgeJsonRpcRequest, signal?: AbortSignal,
  ): Promise<BridgeJsonRpcResponse> {
    const raw = asObject(request.params);
    if (raw === null) {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        "A2A tasks/send params.id is required.");
    }
    const id = raw["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        "A2A tasks/send params.id is required.");
    }
    const messageRaw = asObject(raw["message"]);
    const task: A2aSendTaskParams = {
      id,
      sessionId: typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined,
      metadata: raw["metadata"],
      message: {
        role: typeof messageRaw?.["role"] === "string" ? messageRaw["role"] as string : "user",
        parts: Array.isArray(messageRaw?.["parts"]) ? messageRaw!["parts"] as A2aPart[] : [],
        metadata: messageRaw?.["metadata"],
      },
    };

    const resolved = await this.resolveAction(task, signal);
    if (resolved === null) {
      return jsonRpcError(request, BridgeJsonRpcErrorCodes.INVALID_PARAMS,
        "A2A task metadata must identify an exposed NPS action when more than one is available.",
        { error: BridgeErrorCodes.SERVER_TOOL_NOT_FOUND });
    }

    const { backend, action } = resolved;
    const result = await backend.invoke(
      action.actionId, extractActionParams(task), action.async ?? false, signal);

    // §16.3: an auth / limit / unsupported failure MUST surface as a protocol-level error.
    // Reporting it as a *task* — even a failed one — hands the peer agent a task object where
    // it should have received a transport error, and A2A peers retry failed tasks.
    if (!result.ok && mustBeProtocolError(result.npsStatus)) {
      return jsonRpcError(request, toJsonRpc(result.npsStatus),
        result.message ?? result.npsStatus ?? "NWP dispatch failed.",
        { status: result.npsStatus, error: result.nwpError });
    }

    return jsonRpcSuccess(request, toTask(task, result));
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  /**
   * Skill resolution: look for a skill id in `task.metadata`, then `task.message.metadata`,
   * then per-part `part.metadata` then `part.data`. If found, match against
   * `encode(node, action)` **or** the raw `action_id`, case-insensitively. If not found,
   * accept only if exactly one action is exposed across all invokable backends.
   */
  private async resolveAction(
    task: A2aSendTaskParams, signal?: AbortSignal,
  ): Promise<{ backend: INwpBackend; action: NwpActionDescriptor } | null> {
    let requested = firstNonEmpty(
      tryGetString(task.metadata, SKILL_KEYS),
      tryGetString(task.message.metadata, SKILL_KEYS),
    );
    if (!requested) {
      for (const part of task.message.parts ?? []) {
        requested = firstNonEmpty(
          tryGetString(part.metadata, SKILL_KEYS),
          tryGetString(part.data, SKILL_KEYS),
        );
        if (requested) break;
      }
    }

    const candidates: { backend: INwpBackend; action: NwpActionDescriptor }[] = [];
    for (const { backend, descriptor } of await this.invokableBackends(signal)) {
      for (const action of await backend.getActions(signal)) {
        if (!requested) { candidates.push({ backend, action }); continue; }
        const encoded = McpToolName.encode(descriptor.name, action.actionId);
        if (eqIgnoreCase(encoded, requested) || eqIgnoreCase(action.actionId, requested)) {
          return { backend, action };
        }
      }
    }

    // No skill named: only unambiguous when exactly one action is exposed in total.
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private async invokableBackends(
    signal?: AbortSignal,
  ): Promise<{ backend: INwpBackend; descriptor: NwpNodeDescriptor }[]> {
    const list: { backend: INwpBackend; descriptor: NwpNodeDescriptor }[] = [];
    for (const backend of this.backends) {
      const descriptor = await backend.getDescriptor(signal);
      if (isInvokable(descriptor)) list.push({ backend, descriptor });
    }
    return list;
  }
}

// ── Projection ───────────────────────────────────────────────────────────────

/** Project an NWP result onto an A2A task object. */
function toTask(request: A2aSendTaskParams, result: NwpResult): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const payload = result.ok
    ? result.payload ?? {}
    : { status: result.npsStatus, error: result.nwpError, message: result.message };

  return {
    id: request.id,
    sessionId: request.sessionId,
    status: {
      state: result.ok ? "completed" : "failed",
      timestamp,
      message: result.ok ? null : {
        role: "agent",
        parts: [{
          type: "text",
          // §16.3: the NPS code is preserved verbatim in the failure detail.
          text: result.message ?? result.nwpError ?? result.npsStatus ?? "NPS action failed.",
        }],
      },
    },
    artifacts: [{
      name: result.ok ? "nps-result" : "nps-error",
      parts: [{ type: "data", data: payload }],
      index: 0,
    }],
    history: [request.message],
  };
}

/**
 * Argument extraction, in order: `task.metadata.params|arguments` →
 * `task.message.metadata.params|arguments` → per part `part.data.params|arguments` →
 * a `type:"data"` part's whole `data` → a `type:"text"` part becomes `{ text }` → else null.
 */
function extractActionParams(task: A2aSendTaskParams): unknown {
  const fromMetadata = tryGetElement(task.metadata, PARAM_KEYS)
    ?? tryGetElement(task.message.metadata, PARAM_KEYS);
  if (fromMetadata !== undefined) return fromMetadata;

  for (const part of task.message.parts ?? []) {
    const nested = tryGetElement(part.data, PARAM_KEYS);
    if (nested !== undefined) return nested;
    if (eqIgnoreCase(part.type ?? "", "data") && part.data !== undefined) return part.data;
    if (eqIgnoreCase(part.type ?? "", "text") && typeof part.text === "string" && part.text.trim() !== "") {
      return { text: part.text };
    }
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function tryGetElement(source: unknown, names: readonly string[]): unknown {
  const obj = asObject(source);
  if (obj === null) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  }
  return undefined;
}

function tryGetString(source: unknown, names: readonly string[]): string | undefined {
  const value = tryGetElement(source, names);
  return typeof value === "string" ? value : undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined && v.trim() !== "");
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
