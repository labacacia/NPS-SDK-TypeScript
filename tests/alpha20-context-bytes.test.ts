import { conformanceFixture } from './conformance-fixtures.js';
import { readFileSync } from 'node:fs';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkProjectionSignature, decodeProjectionBytes, requestDigestBytes } from '../src/alpha20/context-bytes.js';
import { parseStrictJson } from '../src/alpha20/strict-json.js';
const corpus = JSON.parse(readFileSync(conformanceFixture('alpha20', 'context_crypto_vectors.json'), 'utf8'));
const key = createPublicKey({ key: Buffer.from(corpus.test_key.public_spki_der_hex, 'hex'), format: 'der', type: 'spki' });
const carrier = (raw: string) => Buffer.from(raw).toString('base64url');

for (const vector of corpus.vectors) it(`independent SDK crypto consumption: ${vector.id}`, () => {
  const parsed = decodeProjectionBytes([vector.carrier_base64url]);
  expect(checkProjectionSignature(parsed, key)).toBe(true);
  expect(parsed.payload).toEqual(vector.payload);
  expect(Object.isFrozen(parsed.payload)).toBe(true);
  if (vector.request_profile_numeric_valid === false) {
    // JCS renderer coverage includes 1e21, which is NOT an admissible profile integer.
    expect(() => requestDigestBytes(JSON.stringify(vector.request))).toThrow('NIP-CONTEXT-INVALID');
  } else expect(requestDigestBytes(JSON.stringify(vector.request)).digest).toBe(vector.request_digest);
});

it.each(['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":"\\ud800"}', '"\ud800"',
  '9007199254740993', '1e309', 'NaN', '{"a":1,}', '[1,]', '{} {}', '01', '+1', '\ufeff{}',
  '[', '"unterminated', '{"a":}', '1.', '1e', 'truex', 'nul', '{"a" 1}', '[1 2]', '\u00a0{}'])
('strict JSON rejects %s', raw => expect(() => parseStrictJson(raw, 16384)).toThrow('NIP-CONTEXT-INVALID'));

it('preserves binary64 value, Unicode, key identity and freezes nested data', () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"a":[0.1,"é","e\\u0301","\\ud83d\\ude00"]}', 16384) as any;
  expect(Object.getPrototypeOf(parsed)).toBe(null);
  expect(parsed.a).toEqual([0.1, 'é', 'e\u0301', '😀']);
  expect(Object.isFrozen(parsed.a)).toBe(true);
  expect(Object.isFrozen(parsed.__proto__)).toBe(true);
});
it('enforces exact size and depth', () => {
  expect(parseStrictJson('{}' + ' '.repeat(16382), 16384)).toEqual({});
  expect(() => parseStrictJson('{}' + ' '.repeat(16383), 16384)).toThrow();
  expect(() => parseStrictJson('['.repeat(66) + ']'.repeat(66), 16384)).toThrow();
});
it.each(['1.0', '1e0', '-0'])('preserves required integer lexemes %s', number => {
  expect(() => parseStrictJson(`{"payload":{"revision":${number}}}`, 16384, [['payload', 'revision']])).toThrow();
});
it('rejects raw carrier duplicates, noncanonical encoding, invalid UTF-8 and envelope shape', () => {
  const good = corpus.vectors[0];
  for (const instances of [[], [good.carrier_base64url, good.carrier_base64url], [good.carrier_base64url + '='],
    [Buffer.from([0xff]).toString('base64url')], [carrier('{}')], [carrier('{"payload":{},"signature":"AA"}')],
    [carrier(good.envelope_json.replace('"payload":', '"payload":{},"payload":'))]]) {
    expect(() => decodeProjectionBytes(instances)).toThrow('NIP-CONTEXT-INVALID');
  }
});
it('wrong key, mutated signature and payload do not verify', () => {
  const parsed = decodeProjectionBytes([corpus.vectors[0].carrier_base64url]);
  expect(checkProjectionSignature(parsed, generateKeyPairSync('ed25519').publicKey)).toBe(false);
  expect(checkProjectionSignature({ ...parsed, signature: 'A'.repeat(86) }, key)).toBe(false);
  expect(checkProjectionSignature({ ...parsed, payload: { ...parsed.payload, audience: 'other' } }, key)).toBe(false);
});
