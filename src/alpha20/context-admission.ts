// Experimental admission pipeline. No transport wiring or default replay-store adapter.
import type { KeyObject } from 'node:crypto';
import { checkProjectionSignature, decodeProjectionBytes, requestDigestBytes } from './context-bytes.js';
import { ContextFormatError, type JsonObject, type JsonValue } from './strict-json.js';
import type { FeatureSelection } from './feature-wire-parser.js';

export type Assurance = 'anonymous' | 'attested' | 'verified';
export interface ProjectionClaims {
  readonly profile: 'nps.invocation_context'; readonly revision: 1;
  readonly issuer: string; readonly key_id: string; readonly audience: string; readonly subject: string;
  readonly assurance: Assurance; readonly capabilities: readonly string[]; readonly scope: readonly string[];
  readonly issued_at: number; readonly expires_at: number; readonly projection_id: string; readonly request_digest: string;
}
export class ContextAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ContextAdmissionError'; }
}
export interface ProjectionReplayStore {
  /** MUST atomically check its current clock against acceptBefore and insert-if-absent
   * on (issuer, projectionId). Persist through restart and share across audience replicas.
   * Retain until retainUntil; capacity/storage failure MUST throw, not evict live entries.
   * This interface has NO default/in-memory production implementation.
   */
  claim(input: Readonly<{ audience: string; issuer: string; projectionId: string; acceptBefore: number; retainUntil: number }>):
    Promise<'claimed' | 'duplicate' | 'expired'>;
}
export interface InvocationAdmissionOptions {
  /** Explicit experimental opt-in. Never copy these settings from wire metadata. */
  readonly experimental: boolean;
  /** Derived from independently authenticated channel identity, not the projection itself. */
  readonly allowedIssuers: ReadonlySet<string>;
  readonly audience: string;
  readonly expectedSubject?: string;
  /** Negotiated native selection or independently proven HTTP route guarantee. */
  readonly selectedFeatures: readonly FeatureSelection[];
  readonly maximumAssurance: Assurance;
  readonly allowedCapabilities: ReadonlySet<string>;
  readonly allowedScopes: ReadonlySet<string>;
  readonly clockSeconds: () => number;
  readonly clockSkewSeconds?: number;
  /** Current trusted key mapping. Must not accept embedded keys; revoked keys return undefined. */
  readonly resolveKey: (issuer: string, keyId: string) => Promise<KeyObject | undefined>;
  /** Pure registered-operation/schema/binding validation; no business side effects. */
  readonly validateOperation: (request: JsonObject) => Promise<boolean>;
  /** Receiver-owned per-subject/operation policy, in addition to the fixed delegation ceiling. */
  readonly authorize: (claims: ProjectionClaims, request: JsonObject) => Promise<boolean>;
  readonly replayStore: ProjectionReplayStore;
}
const admitted = Symbol('admitted invocation projection');
export interface AdmittedInvocation {
  readonly [admitted]: true;
  readonly subject: string; readonly issuer: string; readonly audience: string;
  readonly assurance: Assurance; readonly capabilities: readonly string[]; readonly scope: readonly string[];
  readonly projectionId: string;
  /** Frozen exact parsed value: do not reparse raw bytes before handler execution. */
  readonly request: JsonObject;
}
const levels: Record<Assurance, number> = { anonymous: 0, attested: 1, verified: 2 };
const claimFields = ['profile', 'revision', 'issuer', 'key_id', 'audience', 'subject', 'assurance',
  'capabilities', 'scope', 'issued_at', 'expires_at', 'projection_id', 'request_digest'];
function fail(code: string): never { throw new ContextAdmissionError(code); }
function need(condition: unknown): asserts condition { if (!condition) fail('NIP-CONTEXT-INVALID'); }
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= maximum;
}
function matches(value: string, pattern: RegExp): boolean { return value.match(pattern)?.[0] === value; }
function nid(value: unknown): boolean {
  if (!bounded(value, 512)) return false;
  const parts = value.split(':');
  if (parts[0] !== 'urn' || parts[1] !== 'nps' || !['agent', 'node', 'org'].includes(parts[2])) return false;
  // NIP §3 also documents the org CA form without an identifier.
  if (parts.length !== 5 && !(parts[2] === 'org' && parts.length === 4)) return false;
  if (parts.length === 5 && !matches(parts[4], /^[A-Za-z0-9_.-]+/u)) return false;
  const domain = parts[3];
  return domain.length <= 253 && domain.split('.').every(label => label.length <= 63
    && matches(label, /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?/u));
}
function strings(value: JsonValue, maximum: number): readonly string[] {
  need(Array.isArray(value) && value.length <= 64);
  let previous: Buffer | undefined;
  for (const item of value) {
    need(bounded(item, maximum));
    const bytes = Buffer.from(item);
    need(previous === undefined || Buffer.compare(previous, bytes) < 0);
    previous = bytes;
  }
  return value as readonly string[];
}
function claims(payload: JsonObject): ProjectionClaims {
  need(Object.keys(payload).length === claimFields.length && claimFields.every(field => Object.hasOwn(payload, field)));
  need(payload.profile === 'nps.invocation_context' && payload.revision === 1);
  need(nid(payload.issuer) && nid(payload.subject));
  need(bounded(payload.key_id, 128) && matches(payload.key_id, /^[A-Za-z0-9._:-]+/u));
  need(bounded(payload.audience, 512));
  need(payload.assurance === 'anonymous' || payload.assurance === 'attested' || payload.assurance === 'verified');
  strings(payload.capabilities, 128); strings(payload.scope, 256);
  need(typeof payload.issued_at === 'number' && Number.isSafeInteger(payload.issued_at) && payload.issued_at >= 0);
  need(typeof payload.expires_at === 'number' && Number.isSafeInteger(payload.expires_at + 5)
    && payload.expires_at > payload.issued_at && payload.expires_at - payload.issued_at <= 60);
  need(typeof payload.projection_id === 'string' && matches(payload.projection_id, /^[0-9a-f]{32}/u));
  need(typeof payload.request_digest === 'string' && matches(payload.request_digest, /^sha256:[0-9a-f]{64}/u));
  return payload as unknown as ProjectionClaims;
}
function isObject(value: JsonValue): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requestSchema(request: JsonObject, selected: readonly FeatureSelection[]): void {
  const fields = ['protocol', 'operation', 'target', 'idempotency_key', 'required_features', 'body'];
  need(Object.keys(request).length === fields.length && fields.every(field => Object.hasOwn(request, field)));
  need(bounded(request.protocol, 32) && matches(request.protocol, /^[\x21-\x7e]+/u));
  need(bounded(request.operation, 256) && bounded(request.target, 512));
  need(request.idempotency_key === null || bounded(request.idempotency_key, 128));
  need(Array.isArray(request.required_features) && request.required_features.length <= 32);
  const requirements = new Map<string, number>(); let previous = '';
  for (const pair of request.required_features) {
    need(isObject(pair) && Object.keys(pair).length === 2 && bounded(pair.id, 96)
      && matches(pair.id, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+/u));
    need(typeof pair.revision === 'number' && Number.isInteger(pair.revision) && pair.revision >= 1 && pair.revision <= 65535);
    need(pair.id > previous); previous = pair.id;
    if (!selected.some(value => value.id === pair.id && value.revision === pair.revision)) fail('NIP-CONTEXT-BINDING-MISMATCH');
    requirements.set(pair.id, pair.revision);
  }
  if (requirements.get('nps.invocation_context') !== 1) fail('NIP-CONTEXT-BINDING-MISMATCH');
  if (requirements.has('nps.governed_challenge') && requirements.get('nps.production_runtime') !== 1) fail('NIP-CONTEXT-BINDING-MISMATCH');
  need(isObject(request.body));
  if (request.body.encoding === 'json') need(Object.keys(request.body).length === 2 && Object.hasOwn(request.body, 'value'));
  else need(request.body.encoding === 'bytes' && Object.keys(request.body).length === 3
    && bounded(request.body.content_type, 256) && typeof request.body.sha256 === 'string'
    && matches(request.body.sha256, /^sha256:[0-9a-f]{64}/u));
}
function time(claim: ProjectionClaims, options: InvocationAdmissionOptions, skew: number): void {
  const now = options.clockSeconds();
  if (!Number.isSafeInteger(now) || now < 0) fail('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  if (claim.issued_at > now + skew) fail('NIP-CONTEXT-INVALID');
  if (now >= claim.expires_at + skew) fail('NIP-CONTEXT-EXPIRED');
}
async function infrastructure<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch { return fail('NIP-CONTEXT-VERIFIER-UNAVAILABLE'); }
}
function delegation(claim: ProjectionClaims, options: InvocationAdmissionOptions): void {
  if (!options.allowedIssuers.has(claim.issuer)) fail('NIP-CONTEXT-UNTRUSTED');
  if (claim.audience !== options.audience || (options.expectedSubject !== undefined && claim.subject !== options.expectedSubject)) fail('NIP-CONTEXT-BINDING-MISMATCH');
  if (!Object.hasOwn(levels, options.maximumAssurance)) fail('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  if (levels[claim.assurance] > levels[options.maximumAssurance]
    || claim.capabilities.some(value => !options.allowedCapabilities.has(value))
    || claim.scope.some(value => !options.allowedScopes.has(value))) fail('NIP-CONTEXT-BINDING-MISMATCH');
}

/** Admit only after all local checks and atomic replay claim. No application dispatch here.
 * The provided store's durability, replica sharing, clock and capacity semantics must be
 * qualified separately; mock-store tests do not establish production replay protection.
 */
export async function admitInvocationProjection(carriers: readonly string[], requestJson: string,
  options: InvocationAdmissionOptions): Promise<AdmittedInvocation> {
  try {
    if (!options.experimental) fail('NIP-CONTEXT-UNTRUSTED');
    const projection = decodeProjectionBytes(carriers), claim = claims(projection.payload);
    const skew = options.clockSkewSeconds ?? 5;
    need(Number.isInteger(skew) && skew >= 0 && skew <= 5);
    if (!options.allowedIssuers.has(claim.issuer)) fail('NIP-CONTEXT-UNTRUSTED');
    const key = await infrastructure(() => options.resolveKey(claim.issuer, claim.key_id));
    if (!key || !checkProjectionSignature(projection, key)) fail('NIP-CONTEXT-UNTRUSTED');
    delegation(claim, options);
    time(claim, options, skew);
    const request = requestDigestBytes(requestJson);
    requestSchema(request.value, options.selectedFeatures);
    if (request.digest !== claim.request_digest) fail('NIP-CONTEXT-BINDING-MISMATCH');
    if (!await infrastructure(() => options.validateOperation(request.value))
      || !await infrastructure(() => options.authorize(claim, request.value))) fail('NIP-CONTEXT-BINDING-MISMATCH');
    // Re-read key/policy bindings after asynchronous authorization, so a key revoked
    // or ceiling withdrawn during that work cannot pass using the earlier snapshot.
    const currentKey = await infrastructure(() => options.resolveKey(claim.issuer, claim.key_id));
    if (!currentKey || !checkProjectionSignature(projection, currentKey)) fail('NIP-CONTEXT-UNTRUSTED');
    if (!options.experimental) fail('NIP-CONTEXT-UNTRUSTED');
    delegation(claim, options);
    requestSchema(request.value, options.selectedFeatures);
    // Policy/schema/key work may have consumed the remaining lifetime.
    time(claim, options, skew);
    const replay = await infrastructure(() => options.replayStore.claim(Object.freeze({ audience: claim.audience, issuer: claim.issuer,
      projectionId: claim.projection_id, acceptBefore: claim.expires_at + skew, retainUntil: claim.expires_at + 5 })));
    if (replay === 'duplicate') fail('NIP-CONTEXT-REPLAY');
    if (replay === 'expired') fail('NIP-CONTEXT-EXPIRED');
    if (replay !== 'claimed') fail('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
    return Object.freeze({ [admitted]: true as const, subject: claim.subject, issuer: claim.issuer, audience: claim.audience,
      assurance: claim.assurance, capabilities: claim.capabilities, scope: claim.scope,
      projectionId: claim.projection_id, request: request.value });
  } catch (error) {
    if (error instanceof ContextAdmissionError) throw error;
    if (error instanceof ContextFormatError) fail('NIP-CONTEXT-INVALID');
    return fail('NIP-CONTEXT-VERIFIER-UNAVAILABLE');
  }
}
