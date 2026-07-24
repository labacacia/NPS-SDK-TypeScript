// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * RA enrollment policies (NPS-CR-0005 §3). Mirrors the .NET
 * `NPS.NIP.Ca.Ra` namespace: IEnrollmentPolicy, AllowlistPolicy,
 * BootstrapTokenPolicy (+ IBootstrapTokenStore + in-memory),
 * PendingQueuePolicy (+ IPendingStore + in-memory).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { NipCaException, NipRaPendingException } from "../errors.js";
import { RA_NID_NOT_ALLOWED, RA_TOKEN_EXPIRED, RA_TOKEN_INVALID } from "../../error-codes.js";

/** Context passed to an enrollment policy check. */
export interface EnrollmentContext {
  entityType: string;
  identifier: string;
  pubKey: string;
  capabilities: readonly string[];
  scopeJson: string;
  metadataJson?: string | null;
  enrollmentToken?: string | null;
}

/**
 * Gate that must pass before a NIP CA issues an IdentFrame (NPS-CR-0005 §3).
 * `check` resolves when enrollment is permitted; it throws `NipCaException`
 * (denied) or `NipRaPendingException` (queued → 202).
 */
export interface IEnrollmentPolicy {
  check(ctx: EnrollmentContext): Promise<void>;
}

// ── Tier 1: Allowlist ────────────────────────────────────────────────────────

/** Admits registrations whose `identifier` matches a glob pattern. */
export class AllowlistPolicy implements IEnrollmentPolicy {
  private readonly compiled: RegExp[];

  constructor(patterns: readonly string[]) {
    this.compiled = patterns.map(globToRegex);
  }

  check(ctx: EnrollmentContext): Promise<void> {
    for (const re of this.compiled) {
      if (re.test(ctx.identifier)) return Promise.resolve();
    }
    throw new NipCaException(
      `Identifier '${ctx.identifier}' does not match any enrollment allowlist pattern.`,
      RA_NID_NOT_ALLOWED,
    );
  }
}

function globToRegex(pattern: string): RegExp {
  if (pattern === "*") return new RegExp(".*");
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// ── Tier 2: Bootstrap token ──────────────────────────────────────────────────

/** Public metadata for a bootstrap token (value excluded). */
export interface BootstrapTokenInfo {
  id: string;
  label?: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumed: boolean;
  revoked: boolean;
}

/** Persistent store for single-use enrollment bootstrap tokens (NPS-CR-0005 §3.3). */
export interface IBootstrapTokenStore {
  create(label: string | null | undefined, expiresAt: Date): Promise<string>;
  validateAndConsume(token: string): Promise<boolean>;
  list(): Promise<readonly BootstrapTokenInfo[]>;
  revoke(tokenId: string): Promise<boolean>;
}

interface TokenEntry {
  id: string;
  hash: Buffer;
  label?: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumed: boolean;
  revoked: boolean;
}

/** In-memory `IBootstrapTokenStore`. Not durable. */
export class InMemoryBootstrapTokenStore implements IBootstrapTokenStore {
  private readonly tokens: TokenEntry[] = [];

  create(label: string | null | undefined, expiresAt: Date): Promise<string> {
    const raw = "nps-bootstrap-" + randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(raw, "utf8").digest();
    const id = randomBytes(16).toString("hex");
    this.tokens.push({ id, hash, label, createdAt: new Date(), expiresAt, consumed: false, revoked: false });
    return Promise.resolve(raw);
  }

  validateAndConsume(token: string): Promise<boolean> {
    const hash = createHash("sha256").update(token, "utf8").digest();
    for (const e of this.tokens) {
      if (e.consumed || e.revoked) continue;
      if (new Date() > e.expiresAt) continue;
      if (hash.length !== e.hash.length || !timingSafeEqual(hash, e.hash)) continue;
      e.consumed = true;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  list(): Promise<readonly BootstrapTokenInfo[]> {
    return Promise.resolve(
      this.tokens.map((e) => ({
        id: e.id,
        label: e.label,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        consumed: e.consumed,
        revoked: e.revoked,
      })),
    );
  }

  revoke(tokenId: string): Promise<boolean> {
    const e = this.tokens.find((t) => t.id === tokenId);
    if (!e || e.consumed || e.revoked) return Promise.resolve(false);
    e.revoked = true;
    return Promise.resolve(true);
  }
}

/** Tier 2: caller must present a valid single-use bootstrap token. */
export class BootstrapTokenPolicy implements IEnrollmentPolicy {
  constructor(private readonly store: IBootstrapTokenStore) {}

  async check(ctx: EnrollmentContext): Promise<void> {
    const token = ctx.enrollmentToken;
    if (!token || !token.startsWith("nps-bootstrap-"))
      throw new NipCaException(
        "A bootstrap token (prefix 'nps-bootstrap-') is required for enrollment.",
        RA_TOKEN_INVALID,
      );
    const valid = await this.store.validateAndConsume(token);
    if (!valid)
      throw new NipCaException(
        "Bootstrap token is invalid, expired, or already consumed.",
        RA_TOKEN_EXPIRED,
      );
  }
}

// ── Tier 3: Pending queue ────────────────────────────────────────────────────

export enum PendingStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
}

/** A registration request waiting for operator approval. */
export interface PendingRegistration {
  id: string;
  entityType: string;
  identifier: string;
  pubKey: string;
  capabilities: readonly string[];
  scopeJson: string;
  metadataJson?: string | null;
  requestedAt: Date;
  status: PendingStatus;
  rejectReason?: string | null;
}

/** Store for pending registration requests awaiting operator approval (NPS-CR-0005 §3.4). */
export interface IPendingStore {
  enqueue(request: PendingRegistration): Promise<string>;
  list(): Promise<readonly PendingRegistration[]>;
  get(id: string): Promise<PendingRegistration | null>;
  approve(id: string): Promise<boolean>;
  reject(id: string, reason: string): Promise<boolean>;
  readonly pendingCount: number;
}

/** In-memory `IPendingStore` with a lazy age-sweep. Not durable. */
export class InMemoryPendingStore implements IPendingStore {
  private readonly records = new Map<string, PendingRegistration>();

  constructor(private readonly maxAgeMs: number = 7 * 86_400_000) {}

  get pendingCount(): number {
    this.sweep();
    let n = 0;
    for (const r of this.records.values()) if (r.status === PendingStatus.Pending) n++;
    return n;
  }

  enqueue(request: PendingRegistration): Promise<string> {
    this.records.set(request.id, { ...request });
    return Promise.resolve(request.id);
  }

  list(): Promise<readonly PendingRegistration[]> {
    this.sweep();
    return Promise.resolve([...this.records.values()].map((r) => ({ ...r })));
  }

  get(id: string): Promise<PendingRegistration | null> {
    const r = this.records.get(id);
    return Promise.resolve(r ? { ...r } : null);
  }

  approve(id: string): Promise<boolean> {
    const r = this.records.get(id);
    if (!r || r.status !== PendingStatus.Pending) return Promise.resolve(false);
    r.status = PendingStatus.Approved;
    return Promise.resolve(true);
  }

  reject(id: string, reason: string): Promise<boolean> {
    const r = this.records.get(id);
    if (!r || r.status !== PendingStatus.Pending) return Promise.resolve(false);
    r.status = PendingStatus.Rejected;
    r.rejectReason = reason;
    return Promise.resolve(true);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, r] of this.records) {
      if (r.status !== PendingStatus.Pending && r.requestedAt.getTime() < cutoff) {
        this.records.delete(id);
      }
    }
  }
}

/** Tier 3: every inbound registration is queued as a PendingRegistration. */
export class PendingQueuePolicy implements IEnrollmentPolicy {
  constructor(
    private readonly store: IPendingStore,
    private readonly maxSize: number,
  ) {}

  async check(ctx: EnrollmentContext): Promise<void> {
    if (this.store.pendingCount >= this.maxSize)
      throw new NipCaException(
        `Pending enrollment queue is full (max ${this.maxSize}). Retry later.`,
        RA_TOKEN_INVALID,
      );

    const id = randomBytes(16).toString("hex");
    const req: PendingRegistration = {
      id,
      entityType: ctx.entityType,
      identifier: ctx.identifier,
      pubKey: ctx.pubKey,
      capabilities: ctx.capabilities,
      scopeJson: ctx.scopeJson,
      metadataJson: ctx.metadataJson,
      requestedAt: new Date(),
      status: PendingStatus.Pending,
      rejectReason: null,
    };
    await this.store.enqueue(req);
    throw new NipRaPendingException(id);
  }
}
