// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence abstraction + in-memory implementation for NIP CA certificate
 * storage (NPS-3 §8). Mirrors .NET `INipCaStore` / `InMemoryNipCaStore` /
 * `NipCertRecord`.
 */

/** Lineage roles for a certificate record (NPS-CR-0003 §5.1.3). */
export const NID_ROLE_GROUP = "group" as const;
export const NID_ROLE_SESSION = "session" as const;

/** Persisted record of a NIP certificate (NPS-3 §5.1). */
export interface NipCertRecord {
  nid: string;
  entityType: string; // "agent" | "node" | "operator"
  serial: string;
  pubKey: string;
  capabilities: readonly string[];
  scopeJson: string; // JSON blob
  issuedBy: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  metadataJson?: string | null;
  /** Lineage role — "group", "session", or null for ordinary single-NID agents. */
  nidRole?: string | null;
  /** Immediate parent NID (set on session records; null otherwise). */
  parentNid?: string | null;
  /** Full signed lineage object as canonical JSON. */
  lineageJson?: string | null;
}

/** Persistence abstraction for NIP CA certificate storage. */
export interface INipCaStore {
  /** Saves a newly issued record. Throws if the NID or serial already exists. */
  save(record: NipCertRecord): Promise<void>;
  /** Returns the record for `nid`, or null. */
  getByNid(nid: string): Promise<NipCertRecord | null>;
  /** Returns the record for `serial`, or null. */
  getBySerial(serial: string): Promise<NipCertRecord | null>;
  /** Marks a certificate revoked. Returns false if the NID was not found. */
  revoke(nid: string, reason: string, revokedAt: Date): Promise<boolean>;
  /** Generates and reserves the next unique serial (hex, e.g. `0xA3F9C`). Atomic. */
  nextSerial(): Promise<string>;
  /** Returns all records (diagnostics / admin). */
  list(): Promise<readonly NipCertRecord[]>;
  /** Returns all revoked records (for CRL generation). */
  getRevoked(): Promise<readonly NipCertRecord[]>;
  /** Returns every record whose parentNid equals `parentNid` (cascade / audit). */
  getByParentNid(parentNid: string): Promise<readonly NipCertRecord[]>;
}

/**
 * In-memory `INipCaStore` for tests, demos, and single-process dev stacks.
 * Not durable.
 */
export class InMemoryNipCaStore implements INipCaStore {
  private readonly records: NipCertRecord[] = [];
  private serialCounter = 0;

  save(record: NipCertRecord): Promise<void> {
    // Same-NID records are appended for audit; `getByNid` returns the latest
    // (last-wins), which is how renewal replaces the active cert while keeping
    // the prior record. Duplicate-NID registration is rejected upstream in
    // `NipCaService.register` via a `getByNid` pre-check. Serials are unique.
    if (this.records.some((r) => r.serial === record.serial))
      throw new Error(`Serial already exists: ${record.serial}`);
    this.records.push({ ...record });
    return Promise.resolve();
  }

  getByNid(nid: string): Promise<NipCertRecord | null> {
    // LastOrDefault — the active record after renewals.
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i]!.nid === nid) return Promise.resolve({ ...this.records[i]! });
    }
    return Promise.resolve(null);
  }

  getBySerial(serial: string): Promise<NipCertRecord | null> {
    const r = this.records.find((x) => x.serial === serial);
    return Promise.resolve(r ? { ...r } : null);
  }

  revoke(nid: string, reason: string, revokedAt: Date): Promise<boolean> {
    // FindLast among non-revoked records.
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.nid === nid && !r.revokedAt) {
        this.records[i] = { ...r, revokedAt, revokeReason: reason };
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  nextSerial(): Promise<string> {
    this.serialCounter += 1;
    return Promise.resolve(`0x${this.serialCounter.toString(16).toUpperCase()}`);
  }

  list(): Promise<readonly NipCertRecord[]> {
    return Promise.resolve(this.records.map((r) => ({ ...r })));
  }

  getRevoked(): Promise<readonly NipCertRecord[]> {
    return Promise.resolve(this.records.filter((r) => r.revokedAt).map((r) => ({ ...r })));
  }

  getByParentNid(parentNid: string): Promise<readonly NipCertRecord[]> {
    return Promise.resolve(
      this.records.filter((r) => r.parentNid === parentNid).map((r) => ({ ...r })),
    );
  }
}
