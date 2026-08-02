// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** NIP v0.13 portable live-revocation policy. */

import * as ec from "./error-codes.js";

export type NipRevocationMode = "if_configured" | "required";
export type NipRevocationSource = "local_crl" | "callback" | "ca_store" | "ocsp";
export type NipRevocationOutcome = "good" | "revoked" | "unavailable";

export interface NipRevocationDecision {
  valid: boolean;
  stepFailed: number;
  errorCode?: string;
}

export class NipRevocationEvaluation {
  private readonly consulted: NipRevocationSource[] = [];

  constructor(
    private readonly mode: NipRevocationMode,
    private readonly ocspFailOpen: boolean,
  ) {}

  get consultedSources(): readonly NipRevocationSource[] {
    return [...this.consulted];
  }

  observe(
    source: NipRevocationSource,
    outcome: NipRevocationOutcome,
  ): NipRevocationDecision | undefined {
    this.consulted.push(source);
    if (outcome === "good") return undefined;
    if (outcome === "revoked") {
      return { valid: false, stepFailed: 4, errorCode: ec.CERT_REVOKED };
    }
    if (source === "ocsp" && this.ocspFailOpen) return undefined;
    return { valid: false, stepFailed: 4, errorCode: ec.OCSP_UNAVAILABLE };
  }

  complete(): NipRevocationDecision {
    if (this.mode === "required" && this.consulted.length === 0) {
      return { valid: false, stepFailed: 4, errorCode: ec.OCSP_UNAVAILABLE };
    }
    return { valid: true, stepFailed: 0 };
  }
}
