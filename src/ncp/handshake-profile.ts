// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** NCP v0.11 portable native-server admission and negotiation policy. */

import {
  DEFAULT_MAX_PAYLOAD,
  EncodingTier,
  FrameType,
  type FrameHeader,
} from "../core/frames.js";
import { NpsStatusCodes } from "../core/status-codes.js";
import type { HelloFrame } from "./frames.js";
import { NCP_ERROR_CODES } from "./ncp-error-codes.js";
import { PREAMBLE_BYTES, PREAMBLE_LENGTH } from "./preamble.js";

export interface NcpHandshakeProfile {
  minVersion: string;
  npsVersion: string;
  supportedEncodings: readonly string[];
  supportedProtocols: readonly string[];
  maxFramePayload: number;
  extSupport: boolean;
  maxConcurrentStreams: number;
}

export const DEFAULT_NCP_HANDSHAKE_PROFILE: NcpHandshakeProfile = {
  minVersion: "0.1",
  npsVersion: "0.11",
  supportedEncodings: ["msgpack", "json", "binary_vector.v1"],
  supportedProtocols: ["ncp", "nwp", "nip", "ndp", "nop"],
  maxFramePayload: DEFAULT_MAX_PAYLOAD,
  extSupport: false,
  maxConcurrentStreams: 32,
};

export type NcpHandshakeAction =
  | "continue"
  | "accept"
  | "silent_close"
  | "error_close";

export interface NcpHandshakeDecision {
  action: NcpHandshakeAction;
  status?: string;
  error?: string;
  diagnosticError?: string;
  sessionVersion?: string;
  negotiatedEncoding?: string;
  enabledEncodings?: readonly string[];
  supportedProtocols?: readonly string[];
  maxFramePayload?: number;
  extSupport?: boolean;
  maxConcurrentStreams?: number;
}

export function evaluatePreamble(
  received: Uint8Array,
  elapsedMs: number,
  timeoutMs: number,
): NcpHandshakeDecision {
  if (timeoutMs > 0 && elapsedMs >= timeoutMs) return { action: "silent_close" };
  if (received.length < PREAMBLE_LENGTH) return { action: "continue" };
  for (let i = 0; i < PREAMBLE_LENGTH; i += 1) {
    if (received[i] !== PREAMBLE_BYTES[i]) {
      return {
        action: "silent_close",
        diagnosticError: NCP_ERROR_CODES.NCP_PREAMBLE_INVALID,
      };
    }
  }
  return { action: "continue" };
}

export function evaluateHelloHeader(
  header: FrameHeader,
  elapsedMs: number,
  timeoutMs: number,
  maxHelloPayload: number,
): NcpHandshakeDecision {
  if (timeoutMs > 0 && elapsedMs >= timeoutMs) return { action: "silent_close" };
  if (
    header.frameType !== FrameType.HELLO
    || header.encodingTier !== EncodingTier.JSON
    || header.isEncrypted
    || header.isExtended
    || header.payloadLength > maxHelloPayload
  ) {
    return { action: "silent_close" };
  }
  return { action: "continue" };
}

export function negotiateHandshake(
  server: NcpHandshakeProfile,
  client: HelloFrame,
): NcpHandshakeDecision {
  const serverMin = parseVersion(server.minVersion);
  const serverMax = parseVersion(server.npsVersion);
  const clientMin = parseVersion(client.minVersion ?? client.npsVersion);
  const clientMax = parseVersion(client.npsVersion);
  if (!serverMin || !serverMax || !clientMin || !clientMax) return versionError();
  if (compare(serverMin, serverMax) > 0 || compare(clientMin, clientMax) > 0) {
    return versionError();
  }
  const overlapMin = maxVersion(serverMin, clientMin);
  const overlapMax = minVersion(serverMax, clientMax);
  if (compare(overlapMin, overlapMax) > 0) return versionError();

  const serverEncodings = new Set(server.supportedEncodings);
  const stable = client.supportedEncodings.find(
    (token) => (token === "msgpack" || token === "json")
      && serverEncodings.has(token),
  );
  if (!stable) {
    return {
      action: "error_close",
      status: NpsStatusCodes.NPS_SERVER_ENCODING_UNSUPPORTED,
      error: NCP_ERROR_CODES.NCP_ENCODING_UNSUPPORTED,
    };
  }

  const serverProtocols = new Set(server.supportedProtocols);
  const protocols = [...new Set(
    client.supportedProtocols.filter((token) => serverProtocols.has(token)),
  )];
  if (
    !protocols.includes("ncp")
    || client.maxFramePayload <= 0
    || server.maxFramePayload <= 0
    || client.maxConcurrentStreams <= 0
    || server.maxConcurrentStreams <= 0
  ) {
    return versionError();
  }

  const enabled = [stable];
  if (
    serverEncodings.has("binary_vector.v1")
    && client.supportedEncodings.includes("binary_vector.v1")
  ) {
    enabled.push("binary_vector.v1");
  }
  return {
    action: "accept",
    sessionVersion: `${overlapMax[0]}.${overlapMax[1]}`,
    negotiatedEncoding: stable,
    enabledEncodings: enabled,
    supportedProtocols: protocols,
    maxFramePayload: Math.min(
      server.maxFramePayload, client.maxFramePayload),
    extSupport: server.extSupport && client.extSupport,
    maxConcurrentStreams: Math.min(
      server.maxConcurrentStreams, client.maxConcurrentStreams),
  };
}

type Version = readonly [number, number];

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
}

function minVersion(a: Version, b: Version): Version {
  return compare(a, b) <= 0 ? a : b;
}

function maxVersion(a: Version, b: Version): Version {
  return compare(a, b) >= 0 ? a : b;
}

function versionError(): NcpHandshakeDecision {
  return {
    action: "error_close",
    status: NpsStatusCodes.NPS_PROTO_VERSION_INCOMPATIBLE,
    error: NCP_ERROR_CODES.NCP_VERSION_INCOMPATIBLE,
  };
}
