// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side native NCP transport options.
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpServerOptions.cs.
 */

import type { Socket } from "node:net";
import { DEFAULT_MAX_PAYLOAD } from "../core/frames.js";
import { PREAMBLE_READ_TIMEOUT_MS } from "./preamble.js";
import {
  DEFAULT_NCP_HANDSHAKE_PROFILE,
  type NcpHandshakeProfile,
} from "./handshake-profile.js";

export interface NcpServerOptions {
  /**
   * Optional hook that authenticates/wraps the accepted TCP socket before the
   * NCP preamble is read. Use this to install TLS/mTLS. Returning the same
   * socket instance while {@link requireAuthenticatedStream} is true fails fast.
   */
  authenticateStream?: (socket: Socket) => Promise<Socket>;

  /**
   * When true, {@link authenticateStream} must return a different socket
   * instance, making accidental plaintext native mode fail fast.
   */
  requireAuthenticatedStream?: boolean;

  /**
   * Maximum payload accepted for the initial HelloFrame. Defaults to the normal
   * non-extended payload ceiling (65 535 bytes) rather than the 4 GiB extended
   * limit.
   */
  maxHelloPayload?: number;

  /**
   * Wall-clock budget (ms) for the preamble, frame header, and Hello payload
   * read. Defaults to the NCP preamble timeout.
   */
  handshakeReadTimeoutMs?: number;

  /** Separate wall-clock budget (ms) for the Hello header and payload. */
  helloReadTimeoutMs?: number;

  /** Server capabilities used for deterministic negotiation. */
  handshakeProfile?: NcpHandshakeProfile;
}

/** Fills in defaults for any unspecified {@link NcpServerOptions} fields. */
export function resolveServerOptions(
  options?: NcpServerOptions,
): Required<Omit<NcpServerOptions, "authenticateStream">> & Pick<NcpServerOptions, "authenticateStream"> {
  return {
    authenticateStream: options?.authenticateStream,
    requireAuthenticatedStream: options?.requireAuthenticatedStream ?? false,
    maxHelloPayload: options?.maxHelloPayload ?? DEFAULT_MAX_PAYLOAD,
    handshakeReadTimeoutMs: options?.handshakeReadTimeoutMs ?? PREAMBLE_READ_TIMEOUT_MS,
    helloReadTimeoutMs: options?.helloReadTimeoutMs ?? 5_000,
    handshakeProfile: options?.handshakeProfile ?? DEFAULT_NCP_HANDSHAKE_PROFILE,
  };
}
