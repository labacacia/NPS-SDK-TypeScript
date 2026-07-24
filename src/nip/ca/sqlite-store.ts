// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// SQLite-backed NIP CA certificate store (NPS-3 §8). Port of the .NET
// `SqliteNipCaStore`. Suitable for single-binary / embedded CA deployments.
//
// Uses the built-in `node:sqlite` module (Node ≥ 22.5). The table layout,
// column names, index names, serial format (`0x{HEX}`), and ISO-8601 date
// encoding match the .NET reference so the same on-disk database is portable.

import { DatabaseSync } from "node:sqlite";
import type {
  INipCaStore,
  NipCertRecord,
} from "./store.js";

interface CertRow {
  nid: string;
  entity_type: string;
  serial: string;
  pub_key: string;
  capabilities_json: string;
  scope_json: string;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  metadata_json: string | null;
  nid_role: string | null;
  parent_nid: string | null;
  lineage_json: string | null;
}

/**
 * SQLite-backed `INipCaStore`. Construct via {@link SqliteNipCaStore.open},
 * which creates and migrates the database before the store is usable.
 */
export class SqliteNipCaStore implements INipCaStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens (or creates) a SQLite database at `location` (a file path, or
   * `":memory:"`) and applies the NIP CA schema migrations.
   */
  static open(location: string): SqliteNipCaStore {
    const db = new DatabaseSync(location);
    const store = new SqliteNipCaStore(db);
    store.migrate();
    return store;
  }

  /** Closes the underlying database handle. */
  close(): void {
    this.db.close();
  }

  // ── INipCaStore ────────────────────────────────────────────────────────────

  save(record: NipCertRecord): Promise<void> {
    const sql = `
      INSERT INTO nip_certs
          (nid, entity_type, serial, pub_key, capabilities_json, scope_json,
           issued_by, issued_at, expires_at, metadata_json,
           nid_role, parent_nid, lineage_json)
      VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    try {
      this.db.prepare(sql).run(
        record.nid,
        record.entityType,
        record.serial,
        record.pubKey,
        JSON.stringify(record.capabilities),
        record.scopeJson,
        record.issuedBy,
        toIso(record.issuedAt),
        toIso(record.expiresAt),
        record.metadataJson ?? null,
        record.nidRole ?? null,
        record.parentNid ?? null,
        record.lineageJson ?? null,
      );
    } catch (err) {
      // Surface as a rejected promise (matches the async INipCaStore contract).
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  getByNid(nid: string): Promise<NipCertRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM nip_certs WHERE nid = ? ORDER BY issued_at DESC LIMIT 1")
      .get(nid) as unknown as CertRow | undefined;
    return Promise.resolve(row ? readRecord(row) : null);
  }

  getBySerial(serial: string): Promise<NipCertRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM nip_certs WHERE serial = ? LIMIT 1")
      .get(serial) as unknown as CertRow | undefined;
    return Promise.resolve(row ? readRecord(row) : null);
  }

  revoke(nid: string, reason: string, revokedAt: Date): Promise<boolean> {
    const info = this.db
      .prepare(
        "UPDATE nip_certs SET revoked_at = ?, revoke_reason = ? WHERE nid = ? AND revoked_at IS NULL",
      )
      .run(toIso(revokedAt), reason, nid);
    return Promise.resolve(Number(info.changes) > 0);
  }

  nextSerial(): Promise<string> {
    // SQLite file-level locking makes this UPDATE + SELECT atomic per connection.
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE nip_serial SET seq = seq + 1 WHERE id = 1").run();
      const row = this.db.prepare("SELECT seq FROM nip_serial WHERE id = 1").get() as
        | { seq: number | bigint }
        | undefined;
      this.db.exec("COMMIT");
      const next = Number(row?.seq ?? 0);
      return Promise.resolve(`0x${next.toString(16).toUpperCase()}`);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  list(): Promise<readonly NipCertRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM nip_certs ORDER BY issued_at DESC")
      .all() as unknown as CertRow[];
    return Promise.resolve(rows.map(readRecord));
  }

  getRevoked(): Promise<readonly NipCertRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM nip_certs WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC")
      .all() as unknown as CertRow[];
    return Promise.resolve(rows.map(readRecord));
  }

  getByParentNid(parentNid: string): Promise<readonly NipCertRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM nip_certs WHERE parent_nid = ? ORDER BY issued_at DESC")
      .all(parentNid) as unknown as CertRow[];
    return Promise.resolve(rows.map(readRecord));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private migrate(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS nip_certs (
          nid               TEXT NOT NULL,
          entity_type       TEXT NOT NULL,
          serial            TEXT NOT NULL UNIQUE,
          pub_key           TEXT NOT NULL,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          scope_json        TEXT NOT NULL DEFAULT '{}',
          issued_by         TEXT NOT NULL,
          issued_at         TEXT NOT NULL,
          expires_at        TEXT NOT NULL,
          revoked_at        TEXT,
          revoke_reason     TEXT,
          metadata_json     TEXT,
          nid_role          TEXT,
          parent_nid        TEXT,
          lineage_json      TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS idx_nip_certs_nid        ON nip_certs (nid)",
      "CREATE INDEX IF NOT EXISTS idx_nip_certs_serial     ON nip_certs (serial)",
      "CREATE INDEX IF NOT EXISTS idx_nip_certs_parent_nid ON nip_certs (parent_nid)",
      `CREATE TABLE IF NOT EXISTS nip_serial (
          id   INTEGER PRIMARY KEY,
          seq  INTEGER NOT NULL DEFAULT 0
      )`,
      "INSERT OR IGNORE INTO nip_serial (id, seq) VALUES (1, 0)",
    ];
    for (const sql of statements) this.db.exec(sql);

    // Backfill NPS-CR-0003 columns on pre-existing databases (SQLite lacks
    // ADD COLUMN IF NOT EXISTS — discover via PRAGMA and add missing ones).
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(nip_certs)").all() as unknown as { name: string }[]).map(
        (r) => r.name.toLowerCase(),
      ),
    );
    for (const col of ["nid_role     TEXT", "parent_nid   TEXT", "lineage_json TEXT"]) {
      const name = col.split(/\s+/, 1)[0]!.toLowerCase();
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE nip_certs ADD COLUMN ${col}`);
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_nip_certs_parent_nid ON nip_certs (parent_nid)",
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toIso(d: Date): string {
  return d.toISOString();
}

function readRecord(r: CertRow): NipCertRecord {
  return {
    nid: r.nid,
    entityType: r.entity_type,
    serial: r.serial,
    pubKey: r.pub_key,
    capabilities: (JSON.parse(r.capabilities_json) as string[]) ?? [],
    scopeJson: r.scope_json,
    issuedBy: r.issued_by,
    issuedAt: new Date(r.issued_at),
    expiresAt: new Date(r.expires_at),
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
    revokeReason: r.revoke_reason ?? null,
    metadataJson: r.metadata_json ?? null,
    nidRole: r.nid_role ?? null,
    parentNid: r.parent_nid ?? null,
    lineageJson: r.lineage_json ?? null,
  };
}
