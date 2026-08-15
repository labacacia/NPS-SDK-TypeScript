// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Async task store + idempotency cache for the Action Node, ported from the .NET
 * `IActionTaskStore` / `IIdempotencyCache` and their in-memory implementations
 * (NPS-2 §7.1, §7.2). In-memory impls are suitable for single-instance deployments
 * and tests; replace with Redis/PostgreSQL for multi-instance nodes.
 */

// ── Async task store (NPS-2 §7.2) ───────────────────────────────────────────────

/** Task state machine: pending → running → completed / failed / cancelled. */
export interface ActionTaskRecord {
  taskId: string;
  actionId: string;
  status: string; // pending | running | completed | failed | cancelled
  progress?: number;
  createdAt: number; // epoch millis
  updatedAt: number; // epoch millis
  requestId?: string | null;
  agentNid?: string | null;
  result?: unknown;
  error?: unknown;
}

export interface IActionTaskStore {
  create(taskId: string, actionId: string, requestId: string | null, agentNid: string | null): ActionTaskRecord;
  get(taskId: string): ActionTaskRecord | null;
  /** Atomic transition; false if current status no longer matches `expected`. */
  tryTransition(taskId: string, expected: string, next: string): boolean;
  complete(taskId: string, result: unknown): boolean;
  fail(taskId: string, error: unknown): boolean;
  cancel(taskId: string): boolean;
  updateProgress(taskId: string, progress: number): boolean;
  /** Purge terminal-state records older than `retentionMs`. Returns count removed. */
  purgeExpired(retentionMs: number, now: number): number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class InMemoryActionTaskStore implements IActionTaskStore {
  private readonly tasks = new Map<string, ActionTaskRecord>();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  create(taskId: string, actionId: string, requestId: string | null, agentNid: string | null): ActionTaskRecord {
    if (this.tasks.has(taskId)) throw new Error(`Task id collision: ${taskId}`);
    const now = this.clock();
    const rec: ActionTaskRecord = {
      taskId, actionId, status: "pending", createdAt: now, updatedAt: now, requestId, agentNid,
    };
    this.tasks.set(taskId, rec);
    return rec;
  }

  get(taskId: string): ActionTaskRecord | null {
    return this.tasks.get(taskId) ?? null;
  }

  tryTransition(taskId: string, expected: string, next: string): boolean {
    const rec = this.tasks.get(taskId);
    if (!rec || rec.status !== expected) return false;
    rec.status = next;
    rec.updatedAt = this.clock();
    return true;
  }

  complete(taskId: string, result: unknown): boolean {
    const rec = this.tasks.get(taskId);
    if (!rec || TERMINAL.has(rec.status)) return false;
    rec.status = "completed";
    rec.result = result;
    rec.progress = 1.0;
    rec.updatedAt = this.clock();
    return true;
  }

  fail(taskId: string, error: unknown): boolean {
    const rec = this.tasks.get(taskId);
    if (!rec || TERMINAL.has(rec.status)) return false;
    rec.status = "failed";
    rec.error = error;
    rec.updatedAt = this.clock();
    return true;
  }

  cancel(taskId: string): boolean {
    const rec = this.tasks.get(taskId);
    if (!rec || TERMINAL.has(rec.status)) return false;
    rec.status = "cancelled";
    rec.updatedAt = this.clock();
    return true;
  }

  updateProgress(taskId: string, progress: number): boolean {
    const rec = this.tasks.get(taskId);
    if (!rec) return false;
    rec.progress = Math.max(0, Math.min(1, progress));
    rec.updatedAt = this.clock();
    return true;
  }

  purgeExpired(retentionMs: number, now: number): number {
    const cutoff = now - retentionMs;
    let purged = 0;
    for (const [key, rec] of this.tasks) {
      if (TERMINAL.has(rec.status) && rec.updatedAt < cutoff) {
        this.tasks.delete(key);
        purged++;
      }
    }
    return purged;
  }
}

// ── Idempotency cache (NPS-2 §7.1) ──────────────────────────────────────────────

export interface IdempotentEntry {
  actionId: string;
  paramsHash: string;
  result?: unknown;
  streamFrames?: readonly import("../ncp/frames.js").StreamFrame[];
  anchorRef?: string;
  /** Present for async actions — repeated calls get the same task handle. */
  taskId?: string;
  /** Epoch millis at which this entry expires. */
  expiresAt: number;
}

export interface IIdempotencyCache {
  get(actionId: string, idempotencyKey: string): IdempotentEntry | null;
  /**
   * Store an entry. If one already exists with the same key and a different
   * `paramsHash`, returns false (caller raises NWP-ACTION-IDEMPOTENCY-CONFLICT).
   * An identical hash re-stores silently.
   */
  tryStore(actionId: string, idempotencyKey: string, entry: IdempotentEntry): boolean;
  purgeExpired(now: number): number;
}

export class InMemoryIdempotencyCache implements IIdempotencyCache {
  private readonly entries = new Map<string, IdempotentEntry>();
  constructor(private readonly clock: () => number = () => Date.now()) {}

  private static key(actionId: string, idempotencyKey: string): string {
    return `${actionId}${idempotencyKey}`;
  }

  get(actionId: string, idempotencyKey: string): IdempotentEntry | null {
    const key = InMemoryIdempotencyCache.key(actionId, idempotencyKey);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  tryStore(actionId: string, idempotencyKey: string, entry: IdempotentEntry): boolean {
    const key = InMemoryIdempotencyCache.key(actionId, idempotencyKey);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.expiresAt <= this.clock()) {
        this.entries.delete(key);
      } else {
        return existing.paramsHash === entry.paramsHash;
      }
    }
    this.entries.set(key, entry);
    return true;
  }

  purgeExpired(now: number): number {
    let purged = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        purged++;
      }
    }
    return purged;
  }
}
