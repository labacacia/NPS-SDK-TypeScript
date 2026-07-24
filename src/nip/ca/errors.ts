// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** Thrown when a NIP CA operation cannot be completed. Mirrors .NET `NipCaException`. */
export class NipCaException extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
  ) {
    super(message);
    this.name = "NipCaException";
  }
}

/**
 * Thrown by a Tier-3 (pending queue) enrollment policy when a registration
 * request is queued. The router translates this into a `202 Accepted`.
 * Mirrors .NET `NipRaPendingException`.
 */
export class NipRaPendingException extends Error {
  constructor(readonly pendingId: string) {
    super(`Registration queued with pending id: ${pendingId}`);
    this.name = "NipRaPendingException";
  }
}
