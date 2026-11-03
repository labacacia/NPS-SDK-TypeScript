import { conformanceFixture } from './conformance-fixtures.js';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { admitInvocationProjection, type InvocationAdmissionOptions, type ProjectionReplayStore } from '../src/alpha20/context-admission.js';
import { jcsStringify } from '../src/core/canonical-json.js';

const corpus = JSON.parse(readFileSync(conformanceFixture('alpha20', 'context_crypto_vectors.json'), 'utf8'));
const vector = corpus.vectors[0];
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from(corpus.test_key.seed_hex, 'hex')]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(key);
function signed(payload: object): string {
  const signature = sign(null, Buffer.from('NPS-CONTEXT-PROJECTION/1\0' + jcsStringify(payload)), key).toString('base64url');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64url');
}
function harness() {
  let now = 1800000030, revoked = false, dispatched = 0;
  const calls: Parameters<ProjectionReplayStore['claim']>[0][] = [], seen = new Set<string>();
  const scopes = new Set<string>(['fixture:echo']);
  const options: InvocationAdmissionOptions = {
    experimental: true, allowedIssuers: new Set([vector.payload.issuer]), audience: 'service:echo',
    expectedSubject: vector.payload.subject, selectedFeatures: [{ id: 'nps.invocation_context', revision: 1 }],
    maximumAssurance: 'verified', allowedCapabilities: new Set(['example.echo']), allowedScopes: scopes,
    clockSeconds: () => now, resolveKey: async () => revoked ? undefined : publicKey,
    validateOperation: async () => true, authorize: async () => true,
    // Test-only atomic model; deliberately NOT a durable production adapter.
    replayStore: { async claim(input) {
      await Promise.resolve(); calls.push(input);
      if (now >= input.acceptBefore) return 'expired';
      const id = JSON.stringify([input.issuer, input.projectionId]);
      if (seen.has(id)) return 'duplicate';
      seen.add(id); return 'claimed';
    } },
  };
  return { options, calls, seen, scopes, setNow: (value: number) => { now = value; },
    revoke: () => { revoked = true; }, dispatched: () => dispatched,
    async run(carrier = vector.carrier_base64url, request = JSON.stringify(vector.request), override: Partial<InvocationAdmissionOptions> = {}) {
      const admitted = await admitInvocationProjection([carrier], request, { ...options, ...override });
      dispatched++; return admitted;
    } };
}

for (const v of corpus.vectors.filter((v: any) => v.request_profile_numeric_valid !== false))
  it(`admission with test-only atomic store: ${v.id}`, async () => {
    const h = harness(); const admitted = await h.run(v.carrier_base64url, JSON.stringify(v.request));
    expect(admitted.subject).toBe(v.payload.subject);
    expect(admitted.issuer).not.toBe(admitted.subject);
    expect(admitted.request).toEqual(v.request);
    expect(Object.isFrozen(admitted.request.body)).toBe(true);
    expect(admitted).not.toHaveProperty('signature');
    expect(h.calls).toEqual([{ audience: v.payload.audience, issuer: v.payload.issuer, projectionId: v.payload.projection_id,
      acceptBefore: v.payload.expires_at + 5, retainUntil: v.payload.expires_at + 5 }]);
    expect(h.dispatched()).toBe(1);
  });

it.each([
  ['revision', 2], ['issuer', 'not-a-nid'], ['subject', 'urn:nps:node:-bad:subject'], ['key_id', 'bad key'],
  ['assurance', 'admin'], ['capabilities', ['example.echo', 'example.echo']], ['scope', ['z', 'a']],
  ['issued_at', -1], ['expires_at', 1800000000], ['expires_at', 1800000061],
  ['projection_id', 'A'.repeat(32)], ['request_digest', 'sha256:' + 'A'.repeat(64)], ['extra', true],
])('signed but invalid schema %s', async (field, value) => {
  const h = harness();
  await expect(h.run(signed({ ...vector.payload, [field]: value }))).rejects.toMatchObject({ code: 'NIP-CONTEXT-INVALID' });
  expect(h.calls).toHaveLength(0); expect(h.dispatched()).toBe(0);
});
it.each(['protocol', 'operation', 'target', 'idempotency_key', 'body'])('wrong request binding %s never consumes an ID', async field => {
  const h = harness(), request = structuredClone(vector.request);
  if (field === 'body') request.body.value.params.text = 'different'; else request[field] += ':different';
  await expect(h.run(undefined, JSON.stringify(request))).rejects.toMatchObject({ code: 'NIP-CONTEXT-BINDING-MISMATCH' });
  expect(h.calls).toHaveLength(0); expect(h.dispatched()).toBe(0);
  await h.run(); expect(h.dispatched()).toBe(1);
});
it('concurrent valid duplicates admit and dispatch at most once', async () => {
  const h = harness(), results = await Promise.allSettled([h.run(), h.run()]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')[0]).toMatchObject({ reason: { code: 'NIP-CONTEXT-REPLAY' } });
  expect(h.dispatched()).toBe(1); expect(h.seen.size).toBe(1);
});
it('channel binding, unknown key and local opt-in fail closed', async () => {
  for (const override of [{ allowedIssuers: new Set<string>() }, { resolveKey: async () => undefined }, { experimental: false }]) {
    const h = harness(); await expect(h.run(undefined, undefined, override)).rejects.toMatchObject({ code: 'NIP-CONTEXT-UNTRUSTED' });
    expect(h.calls).toHaveLength(0);
  }
});
it('audience, subject, feature support and delegation ceilings fail before replay', async () => {
  for (const override of [{ audience: 'other' }, { expectedSubject: 'other' }, { selectedFeatures: [] },
    { maximumAssurance: 'attested' as const }, { allowedCapabilities: new Set<string>() }, { allowedScopes: new Set<string>() },
    { validateOperation: async () => false }, { authorize: async () => false }]) {
    const h = harness(); await expect(h.run(undefined, undefined, override)).rejects.toMatchObject({ code: 'NIP-CONTEXT-BINDING-MISMATCH' });
    expect(h.calls).toHaveLength(0); expect(h.dispatched()).toBe(0);
  }
});
it('future, exact expiry and expiry during policy evaluation reject', async () => {
  const future = harness(); future.setNow(vector.payload.issued_at - 6);
  await expect(future.run()).rejects.toMatchObject({ code: 'NIP-CONTEXT-INVALID' });
  const expired = harness(); expired.setNow(vector.payload.expires_at + 5);
  await expect(expired.run()).rejects.toMatchObject({ code: 'NIP-CONTEXT-EXPIRED' });
  const slow = harness();
  await expect(slow.run(undefined, undefined, { authorize: async () => { slow.setNow(vector.payload.expires_at + 5); return true; } })).rejects.toMatchObject({ code: 'NIP-CONTEXT-EXPIRED' });
  expect(future.calls.length + expired.calls.length + slow.calls.length).toBe(0);
  const before = harness(); before.setNow(vector.payload.expires_at + 4); await before.run();
});
it('rechecks key revocation and ceiling withdrawal after async policy evaluation', async () => {
  const revoked = harness();
  await expect(revoked.run(undefined, undefined, { authorize: async () => { revoked.revoke(); return true; } })).rejects.toMatchObject({ code: 'NIP-CONTEXT-UNTRUSTED' });
  expect(revoked.calls).toHaveLength(0);
  const withdrawn = harness();
  await expect(withdrawn.run(undefined, undefined, { authorize: async () => { withdrawn.scopes.clear(); return true; } })).rejects.toMatchObject({ code: 'NIP-CONTEXT-BINDING-MISMATCH' });
  expect(withdrawn.calls).toHaveLength(0);
});
it('infrastructure exceptions are bounded and never dispatch', async () => {
  const unavailable = async (): Promise<never> => { throw new Error('sensitive backend details'); };
  for (const override of [{ resolveKey: unavailable }, { validateOperation: unavailable }, { authorize: unavailable },
    { replayStore: { claim: unavailable } }]) {
    const h = harness(); await expect(h.run(undefined, undefined, override)).rejects.toThrow(/^NIP-CONTEXT-VERIFIER-UNAVAILABLE$/);
    expect(h.dispatched()).toBe(0);
  }
});
it('store enforces the final acceptance instant and retains no expired entry', async () => {
  const h = harness();
  await expect(h.run(undefined, undefined, { replayStore: { claim: async input => {
    h.setNow(input.acceptBefore); return h.options.replayStore.claim(input);
  } } })).rejects.toMatchObject({ code: 'NIP-CONTEXT-EXPIRED' });
  expect(h.seen.size).toBe(0); expect(h.dispatched()).toBe(0);
});
it('UTF-8 array ordering differs from UTF-16 object-key ordering', async () => {
  const scope = ['\ue000', '😀'], h = harness();
  await h.run(signed({ ...vector.payload, scope }), undefined, { allowedScopes: new Set(scope) });
  await expect(h.run(signed({ ...vector.payload, scope: [...scope].reverse() }), undefined,
    { allowedScopes: new Set(scope) })).rejects.toMatchObject({ code: 'NIP-CONTEXT-INVALID' });
});
it('unsafe numeric request and erased feature revision lexemes reject before replay', async () => {
  const h = harness(), numbers = corpus.vectors.find((v: any) => v.request_profile_numeric_valid === false);
  await expect(h.run(numbers.carrier_base64url, JSON.stringify(numbers.request))).rejects.toMatchObject({ code: 'NIP-CONTEXT-INVALID' });
  await expect(h.run(undefined, JSON.stringify(vector.request).replace('"revision":1', '"revision":1e0'))).rejects.toMatchObject({ code: 'NIP-CONTEXT-INVALID' });
  expect(h.calls).toHaveLength(0);
});
