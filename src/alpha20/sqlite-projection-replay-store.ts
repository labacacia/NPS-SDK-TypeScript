// Node >=22.13 for unflagged node:sqlite; imported only through the optional subpath.
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProjectionReplayStore } from './context-admission.js';

export interface SqliteProjectionReplayOptions {
  readonly audience: string;
  readonly capacity?: number;
  /** Trusted clock injection for qualification; never populated from wire metadata. */
  readonly clockSeconds?: () => number;
}
const unavailable = () => new Error('NIP-CONTEXT-VERIFIER-UNAVAILABLE');

/** Durable, bounded single-host replay store. Replicas MUST open the SAME local file.
 * Not suitable for independent files, network filesystems or multi-host failover.
 * Open a dedicated application-owned file; no automatic production deployment occurs.
 */
export class SqliteProjectionReplayStore implements ProjectionReplayStore {
  private constructor(private readonly db: DatabaseSync, private readonly audience: string, private readonly capacity: number,
    private readonly clock: () => number) {}

  static open(location: string, options: SqliteProjectionReplayOptions): SqliteProjectionReplayStore {
    const capacity = options.capacity ?? 65536;
    if (!isAbsolute(location) || !options.audience || Buffer.byteLength(options.audience) > 512
      || Buffer.from(options.audience).toString('utf8') !== options.audience
      || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000000) throw unavailable();
    // A newly created database is private. Existing files are not chmod'd or replaced.
    try { closeSync(openSync(location, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(); }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(location);
      db.exec('PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE IF NOT EXISTS nps_context_replay_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
        audience TEXT NOT NULL, capacity INTEGER NOT NULL, last_now INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS nps_context_replays (
        issuer TEXT NOT NULL, projection_id TEXT NOT NULL, retain_until INTEGER NOT NULL,
        PRIMARY KEY(issuer, projection_id));
        CREATE INDEX IF NOT EXISTS nps_context_replays_expiry ON nps_context_replays(retain_until);`);
      db.prepare('INSERT OR IGNORE INTO nps_context_replay_meta VALUES(1,1,?,?,0)').run(options.audience, capacity);
      const meta = db.prepare('SELECT * FROM nps_context_replay_meta WHERE id=1').get() as
        { schema_version: number; audience: string; capacity: number };
      if (meta.schema_version !== 1 || meta.audience !== options.audience || meta.capacity !== capacity) throw unavailable();
      db.exec('COMMIT');
      return new SqliteProjectionReplayStore(db, options.audience, capacity, options.clockSeconds ?? (() => Math.floor(Date.now() / 1000)));
    } catch {
      try { db?.exec('ROLLBACK'); } catch { /* no active transaction */ }
      try { db?.close(); } catch { /* already closed */ }
      throw unavailable();
    }
  }

  close(): void { this.db.close(); }

  async claim(input: Parameters<ProjectionReplayStore['claim']>[0]): Promise<'claimed' | 'duplicate' | 'expired'> {
    let transaction = false;
    try {
      if (input.audience !== this.audience || typeof input.issuer !== 'string' || !input.issuer || Buffer.byteLength(input.issuer) > 512
        || Buffer.from(input.issuer).toString('utf8') !== input.issuer
        || input.projectionId.match(/^[0-9a-f]{32}/u)?.[0] !== input.projectionId
        || !Number.isSafeInteger(input.acceptBefore) || !Number.isSafeInteger(input.retainUntil)
        || input.acceptBefore < 0 || input.retainUntil < input.acceptBefore) throw unavailable();
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      // Read time AFTER obtaining the write lock, not before waiting on another writer.
      const now = this.clock();
      const meta = this.db.prepare('SELECT last_now FROM nps_context_replay_meta WHERE id=1').get() as { last_now: number };
      if (!Number.isSafeInteger(now) || now < 0 || now < meta.last_now) throw unavailable();
      this.db.prepare('UPDATE nps_context_replay_meta SET last_now=? WHERE id=1').run(now);
      let result: 'claimed' | 'duplicate' | 'expired';
      if (now >= input.acceptBefore) result = 'expired';
      else {
        this.db.prepare('DELETE FROM nps_context_replays WHERE retain_until<=?').run(now);
        const existing = this.db.prepare('SELECT 1 FROM nps_context_replays WHERE issuer=? AND projection_id=?').get(input.issuer, input.projectionId);
        if (existing) result = 'duplicate';
        else {
          const count = this.db.prepare('SELECT count(*) AS count FROM nps_context_replays').get() as { count: number };
          if (count.count >= this.capacity) throw unavailable();
          this.db.prepare('INSERT INTO nps_context_replays VALUES(?,?,?)').run(input.issuer, input.projectionId, input.retainUntil);
          result = 'claimed';
        }
      }
      this.db.exec('COMMIT'); transaction = false;
      return result;
    } catch {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch { /* preserve bounded failure */ } }
      throw unavailable();
    }
  }
}
