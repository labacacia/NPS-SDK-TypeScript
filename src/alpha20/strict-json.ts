// Experimental projection/request JSON decoding. No authority or schema admission.
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export class ContextFormatError extends Error {
  readonly code = 'NIP-CONTEXT-INVALID';
  constructor() { super('NIP-CONTEXT-INVALID'); this.name = 'ContextFormatError'; }
}
function invalid(): never { throw new ContextFormatError(); }
function unicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid();
  }
}

/** Return the exact frozen binary64 value that must also be used by handlers.
 * Reject duplicate decoded keys, unpaired surrogates, non-finite numbers and integer
 * values outside the profile safe range. This does not validate operation schemas.
 */
export function parseStrictJson(raw: string, maxBytes: number,
  decimalIntegerPaths: readonly (readonly (string | number)[])[] = []): JsonValue {
  if (typeof raw !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid();
  unicode(raw);
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) invalid();
  let offset = 0;
  function whitespace(): void { while (offset < raw.length && /[\x20\t\r\n]/u.test(raw[offset])) offset++; }
  function string(): string {
    if (raw[offset++] !== '"') invalid();
    const start = offset - 1;
    while (offset < raw.length) {
      const char = raw[offset++];
      if (char === '\\') { offset++; continue; }
      if (char === '"') {
        let value: string;
        try { value = JSON.parse(raw.slice(start, offset)); } catch { invalid(); }
        unicode(value);
        return value;
      }
    }
    return invalid();
  }
  function value(path: (string | number)[], depth: number): JsonValue {
    if (depth > 64) invalid();
    whitespace();
    if (raw[offset] === '"') return string();
    if (raw[offset] === '{') {
      offset++; whitespace();
      const result: Record<string, JsonValue> = Object.create(null);
      if (raw[offset] === '}') { offset++; return Object.freeze(result); }
      for (;;) {
        whitespace();
        const key = string();
        if (Object.hasOwn(result, key)) invalid();
        whitespace(); if (raw[offset++] !== ':') invalid();
        result[key] = value([...path, key], depth + 1);
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === '}') return Object.freeze(result);
        if (delimiter !== ',') invalid();
      }
    }
    if (raw[offset] === '[') {
      offset++; whitespace();
      const result: JsonValue[] = [];
      if (raw[offset] === ']') { offset++; return Object.freeze(result); }
      for (;;) {
        result.push(value([...path, result.length], depth + 1));
        whitespace();
        const delimiter = raw[offset++];
        if (delimiter === ']') return Object.freeze(result);
        if (delimiter !== ',') invalid();
      }
    }
    for (const [token, parsed] of [['null', null], ['true', true], ['false', false]] as const) {
      if (raw.startsWith(token, offset)) { offset += token.length; return parsed; }
    }
    const token = raw.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (!token) invalid();
    offset += token.length;
    if (decimalIntegerPaths.some(p => p.length === path.length && p.every((part, i) => part === path[i]))
      && !/^(?:0|[1-9][0-9]*)$/u.test(token)) invalid();
    const number = Number(token);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid();
    return number;
  }
  const parsed = value([], 0);
  whitespace();
  if (offset !== raw.length) invalid();
  return parsed;
}
