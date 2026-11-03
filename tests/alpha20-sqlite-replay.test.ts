import { conformanceFixture } from './conformance-fixtures.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { SqliteProjectionReplayStore } from '../src/alpha20/sqlite-projection-replay-store.js';
import { admitInvocationProjection } from '../src/alpha20/context-admission.js';
const directories: string[] = [], stores: SqliteProjectionReplayStore[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited;
    }
  }));
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* closed in test */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database(): string { const dir = mkdtempSync(join(tmpdir(), 'nps-alpha20-replay-')); directories.push(dir); return join(dir, 'replay.db'); }
function open(path: string, clock: () => number, capacity = 65536, audience = 'fixture:audience') {
  const store = SqliteProjectionReplayStore.open(path, { audience, clockSeconds: clock, capacity }); stores.push(store); return store;
}
const claim = (id = '1') => ({ audience: 'fixture:audience', issuer: 'fixture:issuer', projectionId: id.repeat(32), acceptBefore: 160, retainUntil: 165 });
function message(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('child message timeout')); }, 10000);
    const received = (value: unknown) => { cleanup(); resolve(value); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const exited = () => { cleanup(); reject(new Error('child exited before message')); };
    function cleanup() { clearTimeout(timeout); child.off('message', received); child.off('error', failed); child.off('exit', exited); }
    child.once('message', received); child.once('error', failed); child.once('exit', exited);
  });
}
function worker(path: string): ChildProcess {
  const child = fork(new URL('./fixtures/alpha20-replay-worker.mjs', import.meta.url),
    [new URL('../dist/alpha20/sqlite-projection-replay-store.js', import.meta.url).href, path],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
  children.push(child); return child;
}

it('persists claims across close/reopen and isolates issuer keys', async () => {
  const path = database(), first = open(path, () => 110);
  expect(await first.claim(claim())).toBe('claimed'); first.close();
  const second = open(path, () => 110);
  expect(await second.claim(claim())).toBe('duplicate');
  expect(await second.claim({ ...claim(), issuer: 'other:issuer' })).toBe('claimed');
});
it('bounds capacity without evicting live IDs and prunes only after retention', async () => {
  let now = 110; const store = open(database(), () => now, 1);
  expect(await store.claim(claim())).toBe('claimed');
  await expect(store.claim(claim('2'))).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  expect(await store.claim(claim())).toBe('duplicate');
  now = 164;
  await expect(store.claim({ ...claim('2'), acceptBefore: 170, retainUntil: 175 })).rejects.toThrow();
  now = 165;
  expect(await store.claim({ ...claim('2'), acceptBefore: 170, retainUntil: 175 })).toBe('claimed');
});
it('rejects expired claims without consuming capacity and fails closed on clock rollback', async () => {
  let now = 160; const store = open(database(), () => now, 1);
  expect(await store.claim(claim())).toBe('expired');
  expect(await store.claim({ ...claim('2'), acceptBefore: 170, retainUntil: 175 })).toBe('claimed');
  now = 159;
  await expect(store.claim(claim())).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
});
it('refuses ephemeral locations, audience/capacity mismatch and closed storage', async () => {
  expect(() => open(':memory:', () => 110)).toThrow();
  const path = database(), store = open(path, () => 110);
  expect(() => SqliteProjectionReplayStore.open(path, { audience: 'other' })).toThrow();
  expect(() => open(path, () => 110, 1)).toThrow();
  await expect(store.claim({ ...claim(), audience: 'other' })).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  store.close(); await expect(store.claim(claim())).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
});
it('lock contention fails closed without consuming the projection ID', async () => {
  const path = database(), store = open(path, () => 110), blocker = new DatabaseSync(path);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    await expect(store.claim(claim())).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
    blocker.exec('ROLLBACK');
    expect(await store.claim(claim())).toBe('claimed');
  } finally { blocker.close(); }
});
it('malformed store inputs and lost schema fail closed', async () => {
  const path = database(), store = open(path, () => 110);
  for (const input of [{ ...claim(), projectionId: '1'.repeat(32) + '\n' }, { ...claim(), issuer: '\ud800' },
    { ...claim(), retainUntil: 159 }]) await expect(store.claim(input)).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  const fault = new DatabaseSync(path);
  try { fault.exec('DROP TABLE nps_context_replays'); } finally { fault.close(); }
  await expect(store.claim(claim())).rejects.toThrow('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
});
it('two real processes sharing one file cannot both claim the same ID', async () => {
  const path = database(); open(path, () => 110).close();
  const first = worker(path), second = worker(path);
  expect(await Promise.all([message(first), message(second)])).toEqual(['ready', 'ready']);
  const responses = [message(first), message(second)]; first.send('claim'); second.send('claim');
  expect((await Promise.all(responses)).map(value => value.result).sort()).toEqual(['claimed', 'duplicate']);
}, 15000);
it('committed claim survives abrupt process termination without graceful close', async () => {
  const path = database(); open(path, () => 110).close();
  const child = worker(path); expect(await message(child)).toBe('ready');
  const result = message(child); child.send('linger'); expect(await result).toEqual({ result: 'claimed' });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  expect(await open(path, () => 110).claim(claim())).toBe('duplicate');
}, 15000);

it('real admission preserves an invalid request ID, then rejects replay after reopen', async () => {
  const corpus = JSON.parse(readFileSync(conformanceFixture('alpha20', 'context_crypto_vectors.json'), 'utf8'));
  const vector = corpus.vectors[0], path = database(), now = vector.payload.issued_at + 30;
  const first = open(path, () => now, 65536, vector.payload.audience);
  const options = { experimental: true, allowedIssuers: new Set([vector.payload.issuer]), audience: vector.payload.audience,
    selectedFeatures: [{ id: 'nps.invocation_context', revision: 1 }], maximumAssurance: 'verified' as const,
    allowedCapabilities: new Set<string>(vector.payload.capabilities), allowedScopes: new Set<string>(vector.payload.scope),
    clockSeconds: () => now, resolveKey: async () => createPublicKey({ key: Buffer.from(corpus.test_key.public_spki_der_hex, 'hex'), format: 'der', type: 'spki' }),
    validateOperation: async () => true, authorize: async () => true, replayStore: first };
  const request = JSON.stringify(vector.request), carriers = [vector.carrier_base64url];
  await expect(admitInvocationProjection(carriers, request, { ...options, validateOperation: async () => false }))
    .rejects.toMatchObject({ code: 'NIP-CONTEXT-BINDING-MISMATCH' });
  let dispatched = 0;
  await admitInvocationProjection(carriers, request, options).then(() => dispatched++);
  first.close();
  await expect(admitInvocationProjection(carriers, request, { ...options, replayStore: open(path, () => now, 65536, vector.payload.audience) }).then(() => dispatched++))
    .rejects.toMatchObject({ code: 'NIP-CONTEXT-REPLAY' });
  expect(dispatched).toBe(1);
});
