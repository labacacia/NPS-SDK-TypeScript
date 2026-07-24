// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** NWP error codes used by Bridge dispatchers (port of .NET `BridgeErrorCodes`). */
export const BridgeErrorCodes = {
  /** The invocation does not contain a valid `bridge_target`. */
  TargetInvalid: "NWP-BRIDGE-TARGET-INVALID",
  /** The requested bridge protocol has no registered dispatcher. */
  ProtocolUnsupported: "NWP-BRIDGE-PROTOCOL-UNSUPPORTED",
  /** The target endpoint is invalid or disallowed. */
  EndpointInvalid: "NWP-BRIDGE-ENDPOINT-INVALID",
  /** The external call failed or returned an unusable response. */
  UpstreamFailed: "NWP-BRIDGE-UPSTREAM-FAILED",
  /** An inbound Bridge server request named a tool/action that is not exposed. */
  ServerToolNotFound: "NWP-BRIDGE-SERVER-TOOL-NOT-FOUND",
  /** An inbound Bridge server was not configured with a local action dispatcher. */
  ServerDispatcherMissing: "NWP-BRIDGE-SERVER-DISPATCHER-MISSING",
  /** An inbound Bridge server local action dispatch failed unexpectedly. */
  ServerDispatchFailed: "NWP-BRIDGE-SERVER-DISPATCH-FAILED",
} as const;

export type BridgeErrorCode = (typeof BridgeErrorCodes)[keyof typeof BridgeErrorCodes];

/**
 * Error raised when a Bridge Node cannot parse, route, or execute a bridge
 * invocation. `errorCode` carries the NWP-compatible failure code.
 */
export class BridgeDispatchException extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BridgeDispatchException";
    this.errorCode = errorCode;
  }
}
