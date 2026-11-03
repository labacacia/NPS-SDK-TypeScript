// Cryptographic byte primitives only. A valid signature is NOT an admitted identity.
import { createHash, KeyObject, verify } from 'node:crypto';
import { jcsStringify } from '../core/canonical-json.js';
import { ContextFormatError, type JsonObject, type JsonValue, parseStrictJson } from './strict-json.js';

export interface UnadmittedProjection {
  readonly payload: JsonObject;
  readonly signature: string;
}
function object(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function base64url(raw: string, maximum: number): Buffer {
  if (typeof raw !== 'string' || raw.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(raw)) throw new ContextFormatError();
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw new ContextFormatError();
  return bytes;
}

/** Decode the one raw carrier. Payload schema, time, issuer, policy and replay are NOT checked. */
export function decodeProjectionBytes(instances: readonly string[]): UnadmittedProjection {
  if (instances.length !== 1) throw new ContextFormatError();
  const bytes = base64url(instances[0], 21846);
  if (bytes.length > 16384) throw new ContextFormatError();
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ContextFormatError(); }
  const envelope = parseStrictJson(raw, 16384, [['payload', 'revision'], ['payload', 'issued_at'], ['payload', 'expires_at']]);
  if (!object(envelope) || Object.keys(envelope).length !== 2 || !object(envelope.payload)
    || typeof envelope.signature !== 'string' || base64url(envelope.signature, 86).length !== 64) throw new ContextFormatError();
  return Object.freeze({ payload: envelope.payload, signature: envelope.signature });
}

/** Check only signature bytes with an independently configured Ed25519 public key.
 * Caller still MUST validate profile/schema, channel issuer, subject/audience, time,
 * digest, local delegation policy and atomic durable replay before any dispatch.
 * Does not look up keys from the envelope or export an admitted-context type.
 */
export function checkProjectionSignature(projection: UnadmittedProjection, configuredKey: KeyObject): boolean {
  if (configuredKey.type !== 'public' || configuredKey.asymmetricKeyType !== 'ed25519') return false;
  try {
    const payload = jcsStringify(projection.payload);
    return verify(null, Buffer.concat([Buffer.from('NPS-CONTEXT-PROJECTION/1\0'), Buffer.from(payload)]),
      configuredKey, base64url(projection.signature, 86));
  } catch { return false; }
}

/** Canonicalize the raw resolved request object after strict decoding. NOT a schema verifier.
 * Return the parsed value as well: handlers must not reparse into different numeric semantics.
 */
export function requestDigestBytes(raw: string): { readonly value: JsonObject; readonly digest: string } {
  const value = parseStrictJson(raw, 1048576,
    Array.from({ length: 32 }, (_, index) => ['required_features', index, 'revision']));
  if (!object(value)) throw new ContextFormatError();
  const canonical = jcsStringify(value);
  if (Buffer.byteLength(canonical) > 1048576) throw new ContextFormatError();
  const digest = 'sha256:' + createHash('sha256').update('NPS-INVOKE-REQUEST/1\0').update(canonical).digest('hex');
  return Object.freeze({ value, digest });
}
