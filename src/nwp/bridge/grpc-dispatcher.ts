// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

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
  estimateTokenCostBytes,
  sendWithTimeout,
} from "./http-common.js";

/**
 * Built-in Bridge dispatcher for unary gRPC calls using the JSON gRPC codec
 * (`application/grpc+json`). The endpoint path identifies the service and
 * method, e.g. `https://host/Package.Service/Method`.
 */
export class GrpcBridgeDispatcher implements IBridgeDispatcher {
  /** Anchor reference used for gRPC bridge response records. */
  static readonly ResponseAnchorRef = "nps://bridge/grpc-json-response/v1";

  readonly protocol = BridgeProtocols.GRPC;

  constructor(private readonly fetchFn: FetchFn = globalFetch) {}

  async dispatch(frame: ActionFrame, target: BridgeTarget): Promise<CapsFrame> {
    const uri = BridgeEndpointValidator.parseHttpEndpoint(target);

    const headers = new Headers();
    headers.set("content-type", "application/grpc+json");
    headers.set("te", "trailers");
    applyStringHeaders(headers, target);

    const message = buildGrpcMessage(frame, target);

    const response = await sendWithTimeout(
      this.fetchFn,
      uri.toString(),
      { method: "POST", headers, body: message as BodyInit },
      frame.timeoutMs,
      "gRPC bridge request",
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    const record = buildResponseRecord(response, bytes);
    return new CapsFrame(
      GrpcBridgeDispatcher.ResponseAnchorRef,
      1,
      [record],
      undefined,
      estimateTokenCostBytes(bytes.length),
    );
  }
}

function buildGrpcMessage(frame: ActionFrame, target: BridgeTarget): Uint8Array {
  let payload: unknown;

  const targetMessage =
    BridgeTargetParser.tryGetJson(target, "grpc_message") ??
    BridgeTargetParser.tryGetJson(target, "message") ??
    BridgeTargetParser.tryGetJson(target, "body");

  const params = frame.params;
  if (targetMessage !== undefined) {
    payload = targetMessage.value;
  } else if (
    params != null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    "grpc_message" in params
  ) {
    payload = (params as Record<string, unknown>)["grpc_message"];
  } else if (params != null) {
    payload = params;
  } else {
    payload = {};
  }

  const json = new TextEncoder().encode(JSON.stringify(payload));
  const wire = new Uint8Array(json.length + 5);
  wire[0] = 0;
  new DataView(wire.buffer).setUint32(1, json.length, false);
  wire.set(json, 5);
  return wire;
}

function buildResponseRecord(response: Response, body: Uint8Array): Record<string, unknown> {
  const grpcStatus = response.headers.get("grpc-status");
  const grpcMessage = response.headers.get("grpc-message");
  const contentType = response.headers.get("content-type");

  return {
    status_code: response.status,
    success: response.ok && (grpcStatus === "0" || grpcStatus === null),
    content_type: contentType,
    grpc_status: grpcStatus,
    grpc_message: grpcMessage,
    headers: collectResponseHeaders(response),
    // WHATWG fetch cannot surface HTTP/2 trailers; kept for wire-shape parity.
    trailers: {},
    messages: [...readGrpcMessages(body)].map(decodeMessage),
  };
}

function* readGrpcMessages(body: Uint8Array): Generator<Uint8Array> {
  let offset = 0;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  while (body.length - offset >= 5) {
    const compressed = body[offset] !== 0;
    const length = view.getUint32(offset + 1, false);
    offset += 5;

    if (compressed || body.length - offset < length) return;

    yield body.subarray(offset, offset + length);
    offset += length;
  }
}

function decodeMessage(message: Uint8Array): unknown {
  const text = new TextDecoder().decode(message);
  try {
    return JSON.parse(text);
  } catch {
    return base64Encode(message);
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(bytes).toString("base64");
}
