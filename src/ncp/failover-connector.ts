// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS-CR-0009 §3.3 — native-path failover reconnect / session continuity.
 *
 * A transport-agnostic retry wrapper: on a failover-shaped connect failure it **re-resolves
 * the active Anchor and reconnects**. Both resolution and connection are injected delegates,
 * so the connector carries no NDP dependency and is generic in the session type — it wraps a
 * TCP client, a TLS client, or a test double identically.
 *
 * Server side of the same story: when an Anchor transfers ownership it MAY close native
 * connections; the fenced prior leader MUST send a terminal `anchor_failover` then close its
 * streams (see `nwp/anchor-epoch.ts`).
 */

import { NpsError } from "../core/exceptions.js";
import { NCP_ERROR_CODES } from "./ncp-error-codes.js";

/** Host/port of the currently active Anchor. */
export interface AnchorEndpoint {
  host: string;
  port: number;
}

/**
 * Resolves the currently active Anchor. Called **once per attempt, before connecting** —
 * re-resolution is what picks up the new active Anchor after a failover.
 *
 * Compose it with either NDP highest-epoch resolution (`ndp/cluster.ts`) or the
 * `successor_nid` carried by a received `anchor_failover` event.
 */
export type ResolveActiveAnchor = (signal?: AbortSignal) => Promise<AnchorEndpoint> | AnchorEndpoint;

/** Opens a session to one endpoint. */
export type ConnectToAnchor<TSession> =
  (host: string, port: number, signal?: AbortSignal) => Promise<TSession> | TSession;

/** Predicate deciding whether a failure should trigger a re-resolve + retry. */
export type FailoverShapedMatcher = (error: unknown) => boolean;

/** Node system-error codes that mean "this endpoint went away" — i.e. socket / IO errors. */
const SOCKET_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH",
  "EHOSTDOWN", "ENETUNREACH", "ENETDOWN", "ENETRESET", "ENOTFOUND", "EAI_AGAIN",
  "EADDRNOTAVAIL", "ESHUTDOWN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Whether `error` is failover-shaped: a socket / IO error, or an NPS error carrying the
 * protocol error code `NCP-NID-MISMATCH` (the native-path failover trigger — the endpoint we
 * reached is no longer the NID we expected).
 *
 * Anything else propagates immediately, unwrapped and unretried.
 */
export function isFailoverShaped(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;

  // NPS protocol error carrying NCP-NID-MISMATCH.
  const code = e["protocolErrorCode"] ?? e["errorCode"] ?? e["nwpErrorCode"];
  if (code === NCP_ERROR_CODES.NCP_NID_MISMATCH) return true;
  if (error instanceof NpsError && typeof e["message"] === "string" &&
      (e["message"] as string).includes(NCP_ERROR_CODES.NCP_NID_MISMATCH)) {
    return true;
  }

  // Node system errors (socket / IO). `AggregateError` from happy-eyeballs wraps them.
  if (typeof e["code"] === "string" && SOCKET_ERROR_CODES.has(e["code"] as string)) return true;
  if (typeof e["syscall"] === "string" && typeof e["errno"] === "number") return true;
  const errors = e["errors"];
  if (Array.isArray(errors) && errors.length > 0 && errors.every(isFailoverShaped)) return true;

  return false;
}

export interface NcpFailoverConnectorOptions<TSession> {
  /** Required. Called once per attempt, before {@link connect}. */
  resolveActive: ResolveActiveAnchor;
  /** Required. Opens the session. */
  connect: ConnectToAnchor<TSession>;
  /** Must be ≥ 1. Default 2 — one failover retry. */
  maxAttempts?: number;
  /** Override the failover-shape predicate. Defaults to {@link isFailoverShaped}. */
  isFailoverShaped?: FailoverShapedMatcher;
}

/**
 * ```
 * connect():
 *   last_error = null
 *   for attempt in 1..max_attempts:
 *       throw_if_cancelled()
 *       (host, port) = resolve_active()      # RE-RESOLVED EVERY ATTEMPT, incl. the first
 *       try: return connect(host, port)
 *       catch e where is_failover_shaped(e): last_error = e
 *       # any other error propagates immediately, unwrapped
 *   raise last_error                         # rethrow the LAST failure, original type intact
 * ```
 */
export class NcpFailoverConnector<TSession> {
  private readonly resolveActive: ResolveActiveAnchor;
  private readonly connectTo: ConnectToAnchor<TSession>;
  readonly maxAttempts: number;
  private readonly matcher: FailoverShapedMatcher;

  constructor(options: NcpFailoverConnectorOptions<TSession>) {
    if (typeof options?.resolveActive !== "function") {
      throw new TypeError("NcpFailoverConnector requires a resolveActive delegate.");
    }
    if (typeof options.connect !== "function") {
      throw new TypeError("NcpFailoverConnector requires a connect delegate.");
    }
    const maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("NcpFailoverConnector maxAttempts must be an integer >= 1.");
    }
    this.resolveActive = options.resolveActive;
    this.connectTo = options.connect;
    this.maxAttempts = maxAttempts;
    this.matcher = options.isFailoverShaped ?? isFailoverShaped;
  }

  /** Resolve → connect, retrying on failover-shaped failures up to `maxAttempts` times. */
  async connect(signal?: AbortSignal): Promise<TSession> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      const { host, port } = await this.resolveActive(signal);
      try {
        return await this.connectTo(host, port, signal);
      } catch (e) {
        if (!this.matcher(e)) throw e;   // not failover-shaped: propagate, unwrapped
        lastError = e;
      }
    }
    throw lastError;                      // rethrow the LAST failure, original type preserved
  }
}
