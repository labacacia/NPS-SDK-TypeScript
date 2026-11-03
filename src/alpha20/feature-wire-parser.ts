// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
// Experimental parsing only. No feature advertisement, negotiation or admission.
export interface FeatureRevision { readonly revision: number; readonly lifecycle: 'experimental' | 'stable' | 'deprecated' }
export interface FeatureSelection { readonly id: string; readonly revision: number }
export interface FeatureOffer {
  readonly features: Readonly<Record<string, readonly FeatureRevision[]>>;
  readonly required: readonly string[];
}
export class FeatureFormatError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'FeatureFormatError'; }
}
const nativeInvalid = 'NCP-FEATURE-NEGOTIATION-INVALID';
const httpInvalid = 'NWP-FEATURE-REQUIREMENTS-INVALID';
function need(condition: unknown): asserts condition { if (!condition) throw new Error('invalid feature syntax'); }
function validUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96
    && value.match(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+/u)?.[0] === value;
}
function members(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  need(Object.keys(object).every(key => allowed.includes(key)));
  return object;
}

/** Feature-only JSON reader. All numeric fields here require unsigned integer tokens.
 * JSON.parse checks grammar; a raw-token pass catches duplicate decoded keys and
 * numeric spellings JSON.parse would erase. This is NOT a general I-JSON parser.
 */
function featureJson(raw: string): unknown {
  need(validUnicode(raw) && Buffer.byteLength(raw, 'utf8') <= 16384);
  const result: unknown = JSON.parse(raw);
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length;) {
    const char = raw[i];
    if (char === '"') {
      const start = i++;
      while (raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
      i++;
      const decoded: string = JSON.parse(raw.slice(start, i));
      need(validUnicode(decoded));
      let next = i;
      while (/\s/u.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] === ':') {
        const keys = stack.at(-1);
        need(keys && !keys.has(decoded));
        keys.add(decoded);
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null);
      need(stack.length <= 64);
      i++;
    } else if (char === '}' || char === ']') { stack.pop(); i++; }
    else if (char === '-' || /[0-9]/u.test(char)) {
      const start = i++;
      while (i < raw.length && /[0-9eE+.\-]/u.test(raw[i])) i++;
      const token = raw.slice(start, i);
      need(/^[1-9][0-9]{0,4}$/u.test(token) && Number(token) <= 65535);
    } else i++;
  }
  return result;
}

/** Standalone feature block, not the complete Hello carrier or handshake validator. */
export function parseFeatureOffer(raw: string): FeatureOffer {
  try {
    need(typeof raw === 'string');
    const block = members(featureJson(raw), ['feature_negotiation', 'feature_offer', 'required_features']);
    const features: Record<string, readonly FeatureRevision[]> = Object.create(null);
    const required: string[] = [];
    if (Object.keys(block).length) need(block.feature_negotiation === 1);
    if (Object.hasOwn(block, 'feature_offer')) {
      need(Array.isArray(block.feature_offer) && block.feature_offer.length <= 32);
      for (const value of block.feature_offer) {
        const item = members(value, ['id', 'revisions']);
        need(validId(item.id) && !Object.hasOwn(features, item.id));
        need(Array.isArray(item.revisions) && item.revisions.length >= 1 && item.revisions.length <= 16);
        let last = 0;
        const revisions: FeatureRevision[] = [];
        for (const value of item.revisions) {
          const entry = members(value, ['revision', 'lifecycle']);
          need(typeof entry.revision === 'number' && Number.isInteger(entry.revision)
            && entry.revision > last && entry.revision <= 65535);
          need(entry.lifecycle === 'experimental' || entry.lifecycle === 'stable' || entry.lifecycle === 'deprecated');
          revisions.push(Object.freeze({ revision: entry.revision, lifecycle: entry.lifecycle }));
          last = entry.revision;
        }
        features[item.id] = Object.freeze(revisions);
      }
    }
    if (Object.hasOwn(block, 'required_features')) {
      need(Array.isArray(block.required_features) && block.required_features.length <= 32);
      for (const id of block.required_features) {
        need(validId(id) && Object.hasOwn(features, id) && !required.includes(id));
        required.push(id);
      }
    }
    return Object.freeze({ features: Object.freeze(features), required: Object.freeze(required) });
  } catch { throw new FeatureFormatError(nativeInvalid); }
}

/** Raw header instances before framework joining; absent is distinct from empty. */
export function parseRequiredFeatureHeader(instances: readonly string[]): readonly FeatureSelection[] {
  try {
    need(Array.isArray(instances) && instances.length <= 1);
    if (!instances.length) return Object.freeze([]);
    const raw = instances[0];
    need(typeof raw === 'string' && raw.length <= 4096 && /^[\x00-\x7f]*$/u.test(raw));
    const pairs = raw.split(',');
    need(pairs.length >= 1 && pairs.length <= 32);
    let last = '';
    return Object.freeze(pairs.map(pair => {
      const parts = pair.split('=');
      need(parts.length === 2);
      const [id, digits] = parts;
      need(validId(id) && id > last && digits.match(/^[1-9][0-9]{0,4}/u)?.[0] === digits);
      const revision = Number(digits);
      need(revision <= 65535);
      last = id;
      return Object.freeze({ id, revision });
    }));
  } catch { throw new FeatureFormatError(httpInvalid); }
}
