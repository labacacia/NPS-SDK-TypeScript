// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { CapsFrame } from "../../ncp/frames.js";
import type { ActionFrame } from "../frames.js";
import { BridgeEndpointValidator } from "./endpoint-validator.js";
import { BridgeTargetParser, type BridgeTarget } from "./target.js";
import type { FetchFn, IBridgeDispatcher } from "./dispatcher.js";
import { globalFetch } from "./dispatcher.js";
import { BridgeProtocols } from "../bridge.js";
import {
  applyStringHeaders,
  collectResponseHeaders,
  estimateTokenCost,
  isJsonContentType,
  sendWithTimeout,
} from "./http-common.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base dispatcher for JSON-RPC 2.0 protocols transported over HTTP POST. */
export abstract class JsonRpcBridgeDispatcher implements IBridgeDispatcher {
  abstract readonly protocol: string;

  protected constructor(
    private readonly fetchFn: FetchFn,
    private readonly defaultMethod: string,
    private readonly responseAnchorRef: string,
  ) {
    if (!defaultMethod || defaultMethod.trim() === "") {
      throw new Error("Default JSON-RPC method must not be empty.");
    }
    if (!responseAnchorRef || responseAnchorRef.trim() === "") {
      throw new Error("Response anchor reference must not be empty.");
    }
  }

  async dispatch(frame: ActionFrame, target: BridgeTarget): Promise<CapsFrame> {
    const uri = BridgeEndpointValidator.parseHttpEndpoint(target);

    const headers = new Headers();
    headers.set("content-type", "application/json");
    applyStringHeaders(headers, target);

    const body = this.buildRequestBody(frame, target);

    const response = await sendWithTimeout(
      this.fetchFn,
      uri.toString(),
      { method: "POST", headers, body },
      frame.timeoutMs,
      `${this.protocol} JSON-RPC bridge request`,
    );

    const bodyText = await response.text();
    const record = buildResponseRecord(response, bodyText);
    return new CapsFrame(this.responseAnchorRef, 1, [record], undefined, estimateTokenCost(bodyText));
  }

  private buildRequestBody(frame: ActionFrame, target: BridgeTarget): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: this.readRequestId(frame, target),
      method: this.readRpcMethod(frame, target),
      params: this.readRpcParams(frame, target),
    });
  }

  private readRpcMethod(frame: ActionFrame, target: BridgeTarget): string {
    const method =
      BridgeTargetParser.getString(target, "rpc_method") ??
      BridgeTargetParser.getString(target, "method");
    if (method != null && method.trim() !== "") return method;

    const params = frame.params;
    if (isObject(params)) {
      const frameMethod = params["rpc_method"];
      if (typeof frameMethod === "string" && frameMethod.trim() !== "") return frameMethod;
    }

    return this.defaultMethod;
  }

  private readRequestId(frame: ActionFrame, target: BridgeTarget): unknown {
    const targetId = BridgeTargetParser.tryGetJson(target, "id");
    if (targetId !== undefined) return targetId.value;

    const params = frame.params;
    if (isObject(params) && "id" in params) return params["id"];

    return frame.idempotencyKey ?? randomUUID().replace(/-/g, "");
  }

  private readRpcParams(frame: ActionFrame, target: BridgeTarget): unknown {
    const targetParams =
      BridgeTargetParser.tryGetJson(target, "rpc_params") ??
      BridgeTargetParser.tryGetJson(target, "params");
    if (targetParams !== undefined) return targetParams.value;

    const params = frame.params;
    if (!isObject(params)) return {};

    for (const name of ["rpc_params", "params", "body"]) {
      if (name in params) return params[name];
    }

    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "bridge_target" || key === "rpc_method" || key === "method" || key === "id") {
        continue;
      }
      filtered[key] = value;
    }
    return filtered;
  }
}

function buildResponseRecord(response: Response, bodyText: string): Record<string, unknown> {
  const contentType = response.headers.get("content-type");
  const record: Record<string, unknown> = {
    status_code: response.status,
    success: response.ok,
    content_type: contentType,
    headers: collectResponseHeaders(response),
  };
  writeJsonRpcBody(record, bodyText, contentType);
  return record;
}

function writeJsonRpcBody(
  record: Record<string, unknown>,
  bodyText: string,
  contentType: string | null,
): void {
  if (bodyText.trim() !== "" && isJsonContentType(contentType)) {
    try {
      const parsed = JSON.parse(bodyText);
      record["jsonrpc_response"] = parsed;
      if (isObject(parsed)) {
        if ("result" in parsed) record["result"] = parsed["result"];
        if ("error" in parsed) record["error"] = parsed["error"];
      }
      return;
    } catch {
      // Fall through to body_text for mislabeled upstream payloads.
    }
  }
  record["body_text"] = bodyText;
}

/** Built-in Bridge dispatcher for MCP JSON-RPC servers over HTTP POST. */
export class McpBridgeDispatcher extends JsonRpcBridgeDispatcher {
  /** Anchor reference used for MCP bridge response records. */
  static readonly ResponseAnchorRef = "nps://bridge/mcp-jsonrpc-response/v1";

  readonly protocol = BridgeProtocols.MCP;

  constructor(fetchFn: FetchFn = globalFetch) {
    super(fetchFn, "tools/call", McpBridgeDispatcher.ResponseAnchorRef);
  }
}

/** Built-in Bridge dispatcher for A2A JSON-RPC endpoints over HTTP POST. */
export class A2aBridgeDispatcher extends JsonRpcBridgeDispatcher {
  /** Anchor reference used for A2A bridge response records. */
  static readonly ResponseAnchorRef = "nps://bridge/a2a-jsonrpc-response/v1";

  readonly protocol = BridgeProtocols.A2A;

  constructor(fetchFn: FetchFn = globalFetch) {
    super(fetchFn, "tasks/send", A2aBridgeDispatcher.ResponseAnchorRef);
  }
}
