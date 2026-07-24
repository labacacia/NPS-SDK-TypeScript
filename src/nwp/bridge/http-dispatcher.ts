// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { CapsFrame } from "../../ncp/frames.js";
import type { ActionFrame } from "../frames.js";
import { BridgeErrorCodes, BridgeDispatchException } from "./errors.js";
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

/** Built-in Bridge dispatcher for HTTP and HTTPS endpoints. */
export class HttpBridgeDispatcher implements IBridgeDispatcher {
  /** Anchor reference used for HTTP bridge response records. */
  static readonly ResponseAnchorRef = "nps://bridge/http-response/v1";

  readonly protocol = BridgeProtocols.HTTP;

  constructor(private readonly fetchFn: FetchFn = globalFetch) {}

  async dispatch(frame: ActionFrame, target: BridgeTarget): Promise<CapsFrame> {
    const uri = BridgeEndpointValidator.parseHttpEndpoint(target);
    const method = parseMethod(BridgeTargetParser.getString(target, "method", "POST"));

    const headers = new Headers();
    applyStringHeaders(headers, target);

    let body: string | undefined;
    const bodyValue = resolveBody(frame, target, method);
    if (bodyValue !== undefined) {
      const mediaType = BridgeTargetParser.getString(target, "content_type", "application/json")!;
      body = JSON.stringify(bodyValue);
      if (!headerExists(headers, "content-type")) headers.set("content-type", mediaType);
    }

    const response = await sendWithTimeout(
      this.fetchFn,
      uri.toString(),
      { method, headers, body },
      frame.timeoutMs,
      "HTTP bridge request",
    );

    const bodyText = await response.text();
    const record = buildResponseRecord(response, bodyText);
    return new CapsFrame(
      HttpBridgeDispatcher.ResponseAnchorRef,
      1,
      [record],
      undefined,
      estimateTokenCost(bodyText),
    );
  }
}

function parseMethod(method: string | undefined): string {
  const normalized = !method || method.trim() === "" ? "POST" : method.trim().toUpperCase();
  return normalized;
}

function resolveBody(frame: ActionFrame, target: BridgeTarget, method: string): unknown {
  if (method === "GET" || method === "HEAD") return undefined;

  const params = frame.params;
  if (params != null && typeof params === "object" && !Array.isArray(params) && "body" in params) {
    return (params as Record<string, unknown>)["body"];
  }

  const targetBody = BridgeTargetParser.tryGetJson(target, "body");
  if (targetBody !== undefined) return targetBody.value;

  return undefined;
}

function headerExists(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildResponseRecord(response: Response, bodyText: string): Record<string, unknown> {
  const contentType = response.headers.get("content-type");
  const record: Record<string, unknown> = {
    status_code: response.status,
    reason_phrase: response.statusText,
    success: response.ok,
    content_type: contentType,
    headers: collectResponseHeaders(response),
  };
  writeBody(record, bodyText, contentType);
  return record;
}

function writeBody(record: Record<string, unknown>, bodyText: string, contentType: string | null): void {
  if (bodyText.trim() !== "" && isJsonContentType(contentType)) {
    try {
      record["body"] = JSON.parse(bodyText);
      return;
    } catch {
      // Fall through to body_text for mislabeled upstream payloads.
    }
  }
  record["body_text"] = bodyText;
}

export { BridgeErrorCodes, BridgeDispatchException };
