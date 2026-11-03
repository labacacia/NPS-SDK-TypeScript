import { conformanceFixture } from './conformance-fixtures.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFeatureOffer, parseRequiredFeatureHeader } from '../src/alpha20/feature-wire-parser.js';

const corpus = JSON.parse(readFileSync(conformanceFixture('alpha20', 'feature_negotiation_vectors.json'), 'utf8'));
describe('experimental alpha20 strict feature parsers', () => {
  for (const vector of corpus.cases) {
    it(vector.id, () => {
      const parse = () => vector.kind === 'native-offer'
        ? parseFeatureOffer(vector.raw) : parseRequiredFeatureHeader(vector.headers);
      if (['NCP-FEATURE-NEGOTIATION-INVALID', 'NWP-FEATURE-REQUIREMENTS-INVALID'].includes(vector.expected.error)) {
        expect(parse).toThrow(vector.expected.error);
      } else if (vector.kind === 'native-offer') {
        // Selection/policy failures are NOT parser errors.
        const input = JSON.parse(vector.raw);
        const parsed = parseFeatureOffer(vector.raw);
        expect(Object.entries(parsed.features)).toEqual((input.feature_offer ?? []).map((v: any) => [v.id, v.revisions]));
        expect(parsed.required).toEqual(input.required_features ?? []);
      } else expect(parse()).toEqual(vector.expected.required);
    });
  }
  it.each(['1.0', '1e0', '-1', 'null', 'true'])('rejects erased numeric syntax %s', revision => {
    expect(() => parseFeatureOffer(`{"feature_negotiation":1,"feature_offer":[{"id":"example.echo","revisions":[{"revision":${revision},"lifecycle":"stable"}]}]}`)).toThrow();
  });
  it('rejects escaped duplicate decoded keys', () => {
    expect(() => parseFeatureOffer('{"feature_negotiation":1,"feature_\\u006eegotiation":1}')).toThrow();
  });
  it.each(['{"feature_negotiation":1,"required_features":["example.echo\\ud800"]}', '{"feature_negotiation":1,"required_features":["example.echo\ud800"]}'])('rejects invalid Unicode', raw => {
    expect(() => parseFeatureOffer(raw)).toThrow();
  });
  it('deep freezes validated output', () => {
    const parsed = parseFeatureOffer('{"feature_negotiation":1,"feature_offer":[{"id":"example.echo","revisions":[{"revision":1,"lifecycle":"stable"}]}]}');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.features)).toBe(true);
    expect(Object.isFrozen(parsed.features['example.echo'])).toBe(true);
    expect(Object.isFrozen(parsed.features['example.echo'][0])).toBe(true);
    expect(Object.isFrozen(parsed.required)).toBe(true);
    expect(Object.isFrozen(parseRequiredFeatureHeader(['example.echo=1'])[0])).toBe(true);
  });
  it.each(['example.echo=1\n', 'example.echo\n=1'])('rejects trailing regex newline %s', raw => {
    expect(() => parseRequiredFeatureHeader([raw])).toThrow();
  });
});
