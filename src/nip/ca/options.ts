// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * EnrollmentTier + NipCaOptions for the NIP CA service library.
 * Mirrors .NET `EnrollmentTier` / `NipCaOptions`.
 */

/**
 * Enrollment-tier selector for the NIP CA Registration Authority model
 * (NPS-CR-0005 §3).
 */
export enum EnrollmentTier {
  /** Tier 1: operator-configured glob allowlist. Default. */
  Allowlist = 1,
  /** Tier 2: single-use bootstrap token (prefix `nps-bootstrap-`). */
  BootstrapToken = 2,
  /** Tier 3: all registrations queued as pending records. */
  PendingQueue = 3,
}

/** Configuration for the NIP CA service (NPS-3 §8). */
export interface NipCaOptions {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** CA NID, e.g. `urn:nps:org:ca.example.com`. Used as `issued_by`. */
  caNid: string;
  /** Human-readable CA name for `/.well-known/nps-ca`. */
  displayName?: string;

  // ── Certificate lifetimes ──────────────────────────────────────────────────
  /** Agent certificate validity in days. Default 30. */
  agentCertValidityDays?: number;
  /** Node certificate validity in days. Default 90. */
  nodeCertValidityDays?: number;
  /** Renewal window in days before expiry. Default 7. */
  renewalWindowDays?: number;
  /** Orchestrator group NID validity in days. Default 365. */
  groupCertValidityDays?: number;
  /** Default session validity (ms) when the issue request omits it. Default 1h. */
  sessionDefaultValidityMs?: number;
  /** Maximum session validity (ms). Default 24h. */
  sessionMaxValidityMs?: number;
  /** Minimum session validity (ms). Default 60s. */
  sessionMinValidityMs?: number;
  /** Allowed clock-skew (ms) for the group-JWS `iat`. Default ±5m. */
  sessionJwsClockSkewMs?: number;

  // ── Exposure ────────────────────────────────────────────────────────────────
  /** Base URL of this CA server, e.g. `https://ca.example.com`. */
  baseUrl?: string;
  /** HTTP route prefix for CA endpoints. Default "". */
  routePrefix?: string;

  // ── Security ──────────────────────────────────────────────────────────────
  /** When true, OCSP responses are delayed to a minimum of 200ms. Default true. */
  normalizeOcspResponseTime?: boolean;
  /** Supported algorithms advertised in the well-known response. Default ["ed25519"]. */
  algorithms?: readonly string[];

  // ── Auth ──────────────────────────────────────────────────────────────────
  /** Bearer token required on operator endpoints. When null, operator auth is skipped. */
  operatorApiKey?: string | null;
  /** When set, only these capabilities may be requested at registration. */
  allowedCapabilities?: ReadonlySet<string> | null;

  // ── Enrollment / RA (NPS-CR-0005) ────────────────────────────────────────
  /** Enrollment tier. Default Allowlist. */
  enrollmentTier?: EnrollmentTier;
  /** Glob patterns for Tier 1. Default ["*"]. */
  enrollmentAllowlistPatterns?: readonly string[];
  /** Maximum TTL (ms) for bootstrap tokens. Default 24h. */
  bootstrapTokenMaxTtlMs?: number;
  /** Maximum number of Pending records at one time. Default 1000. */
  pendingQueueMaxSize?: number;
  /** Age (ms) after which non-pending records are swept. Default 7d. */
  pendingQueueMaxAgeMs?: number;
}

// ── Defaults ────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface ResolvedNipCaOptions {
  caNid: string;
  displayName?: string;
  agentCertValidityDays: number;
  nodeCertValidityDays: number;
  renewalWindowDays: number;
  groupCertValidityDays: number;
  sessionDefaultValidityMs: number;
  sessionMaxValidityMs: number;
  sessionMinValidityMs: number;
  sessionJwsClockSkewMs: number;
  baseUrl: string;
  routePrefix: string;
  normalizeOcspResponseTime: boolean;
  algorithms: readonly string[];
  operatorApiKey: string | null;
  allowedCapabilities: ReadonlySet<string> | null;
  enrollmentTier: EnrollmentTier;
  enrollmentAllowlistPatterns: readonly string[];
  bootstrapTokenMaxTtlMs: number;
  pendingQueueMaxSize: number;
  pendingQueueMaxAgeMs: number;
}

export function resolveOptions(opts: NipCaOptions): ResolvedNipCaOptions {
  return {
    caNid: opts.caNid,
    displayName: opts.displayName,
    agentCertValidityDays: opts.agentCertValidityDays ?? 30,
    nodeCertValidityDays: opts.nodeCertValidityDays ?? 90,
    renewalWindowDays: opts.renewalWindowDays ?? 7,
    groupCertValidityDays: opts.groupCertValidityDays ?? 365,
    sessionDefaultValidityMs: opts.sessionDefaultValidityMs ?? HOUR,
    sessionMaxValidityMs: opts.sessionMaxValidityMs ?? 24 * HOUR,
    sessionMinValidityMs: opts.sessionMinValidityMs ?? 60_000,
    sessionJwsClockSkewMs: opts.sessionJwsClockSkewMs ?? 5 * 60_000,
    baseUrl: opts.baseUrl ?? "",
    routePrefix: opts.routePrefix ?? "",
    normalizeOcspResponseTime: opts.normalizeOcspResponseTime ?? true,
    algorithms: opts.algorithms ?? ["ed25519"],
    operatorApiKey: opts.operatorApiKey ?? null,
    allowedCapabilities: opts.allowedCapabilities ?? null,
    enrollmentTier: opts.enrollmentTier ?? EnrollmentTier.Allowlist,
    enrollmentAllowlistPatterns: opts.enrollmentAllowlistPatterns ?? ["*"],
    bootstrapTokenMaxTtlMs: opts.bootstrapTokenMaxTtlMs ?? 24 * HOUR,
    pendingQueueMaxSize: opts.pendingQueueMaxSize ?? 1000,
    pendingQueueMaxAgeMs: opts.pendingQueueMaxAgeMs ?? 7 * DAY,
  };
}
