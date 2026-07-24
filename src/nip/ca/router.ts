// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NipCaRouter — CA HTTP routes as a Web-standard Fetch handler
 * (`fetch(Request) => Response`), mirroring the .NET `NPS.NIP.Http.NipCaRouter`
 * minimal-API surface and the TS `AnchorNodeApp.fetch` shape.
 *
 * Maps all CA endpoints + `/.well-known/nps-ca`. Wire field names, error codes,
 * and HTTP statuses match the .NET reference exactly.
 */

import { timingSafeEqual } from "node:crypto";

import {
  CA_JWS_EXPIRED,
  CA_JWS_INVALID,
  RA_NID_NOT_ALLOWED,
  RA_PENDING_REJECTED,
  RA_TOKEN_EXPIRED,
  RA_TOKEN_INVALID,
} from "../error-codes.js";
import { NipCaException, NipRaPendingException } from "./errors.js";
import * as GroupJws from "./group-jws.js";
import { resolveOptions, type NipCaOptions, type ResolvedNipCaOptions } from "./options.js";
import { NipCaService, NipErrorCodes, type CaIdentFrame } from "./service.js";
import { decodePublicKey } from "./signer.js";
import { NID_ROLE_GROUP } from "./store.js";
import {
  PendingStatus,
  type IBootstrapTokenStore,
  type IEnrollmentPolicy,
  type IPendingStore,
} from "./ra/policy.js";

const IDENTIFIER_RE = /^[a-zA-Z0-9._:@/\-]{1,256}$/;

const VALID_REVOCATION_REASONS = new Set<string>([
  "key_compromise",
  "ca_compromise",
  "affiliation_changed",
  "superseded",
  "cessation_of_operation",
  "parent_revoked",
]);

export interface NipCaRouterDeps {
  bootstrapTokenStore?: IBootstrapTokenStore | null;
  pendingStore?: IPendingStore | null;
}

/**
 * NIP CA Fetch app. Construct with a service, options, and optional RA stores,
 * then mount `app.fetch` on any WHATWG-fetch runtime.
 */
export class NipCaRouter {
  private readonly opts: ResolvedNipCaOptions;
  private readonly pfx: string;
  private readonly enrollmentPolicy: IEnrollmentPolicy;

  constructor(
    private readonly ca: NipCaService,
    options: NipCaOptions,
    private readonly deps: NipCaRouterDeps = {},
  ) {
    this.opts = resolveOptions(options);
    this.pfx = this.opts.routePrefix.replace(/\/$/, "");
    this.enrollmentPolicy = NipCaService.createEnrollmentPolicy(
      options,
      deps.bootstrapTokenStore,
      deps.pendingStore,
    );
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const m = req.method.toUpperCase();
    const pfx = this.pfx;

    try {
      // ── Discovery ─────────────────────────────────────────────────────────
      if (path === "/.well-known/nps-ca" && m === "GET") return this.discovery();

      if (path === `${pfx}/v1/ca/cert` && m === "GET")
        return json({ public_key: this.ca.getCaPublicKey(), algorithm: "ed25519" });

      if (path === `${pfx}/v1/crl` && m === "GET") return this.crl();

      // ── Registration ──────────────────────────────────────────────────────
      if (path === `${pfx}/v1/agents/register` && m === "POST") return this.register(req, "agent");
      if (path === `${pfx}/v1/nodes/register` && m === "POST") return this.register(req, "node");
      if (path === `${pfx}/v1/agents/register-x509` && m === "POST") return this.registerX509(req, "agent");
      if (path === `${pfx}/v1/nodes/register-x509` && m === "POST") return this.registerX509(req, "node");

      // ── Group orchestration (NPS-CR-0003) ─────────────────────────────────
      if (path === `${pfx}/v1/orchestrators/groups/register` && m === "POST") return this.registerGroup(req);

      // ── Enrollment (NPS-CR-0005) ──────────────────────────────────────────
      if (path === `${pfx}/v1/enrollment/tokens` && m === "POST") return this.createToken(req);
      if (path === `${pfx}/v1/enrollment/pending` && m === "GET") return this.listPending(req);

      // ── Path-parameterised routes ─────────────────────────────────────────
      const groupSession = matchPath(path, `${pfx}/v1/orchestrators/groups/`, "/sessions/issue");
      if (groupSession && m === "POST") return this.issueSession(req, groupSession);

      const groupSessionsList = matchPath(path, `${pfx}/v1/orchestrators/groups/`, "/sessions");
      if (groupSessionsList && m === "GET") return this.listSessions(req, groupSessionsList);

      const groupRevoke = matchPath(path, `${pfx}/v1/orchestrators/groups/`, "/revoke");
      if (groupRevoke && m === "POST") return this.revoke(req, groupRevoke);

      const agentRenew = matchPath(path, `${pfx}/v1/agents/`, "/renew");
      if (agentRenew && m === "POST") return this.renew(req, agentRenew);
      const nodeRenew = matchPath(path, `${pfx}/v1/nodes/`, "/renew");
      if (nodeRenew && m === "POST") return this.renew(req, nodeRenew);

      const agentRevoke = matchPath(path, `${pfx}/v1/agents/`, "/revoke");
      if (agentRevoke && m === "POST") return this.revoke(req, agentRevoke);
      const nodeRevoke = matchPath(path, `${pfx}/v1/nodes/`, "/revoke");
      if (nodeRevoke && m === "POST") return this.revoke(req, nodeRevoke);

      const agentVerify = matchPath(path, `${pfx}/v1/agents/`, "/verify");
      if (agentVerify && m === "GET") return this.verify(agentVerify);
      const nodeVerify = matchPath(path, `${pfx}/v1/nodes/`, "/verify");
      if (nodeVerify && m === "GET") return this.verify(nodeVerify);

      const approve = matchPath(path, `${pfx}/v1/enrollment/pending/`, "/approve");
      if (approve && m === "POST") return this.approvePending(req, approve);
      const reject = matchPath(path, `${pfx}/v1/enrollment/pending/`, "/reject");
      if (reject && m === "POST") return this.rejectPending(req, reject);

      return json({ error_code: "NIP-CA-NOT-FOUND", message: "No such route." }, 404);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      return json({ error_code: "NIP-CA-SERVER-ERROR", message: String(e) }, 500);
    }
  };

  // ── Discovery ──────────────────────────────────────────────────────────────

  private discovery(): Response {
    const o = this.opts;
    const body = {
      nps_ca: "0.1",
      issuer: o.caNid,
      display_name: o.displayName,
      public_key: this.ca.getCaPublicKey(),
      algorithms: o.algorithms,
      endpoints: {
        register: `${o.baseUrl}${this.pfx}/v1/agents/register`,
        verify: `${o.baseUrl}${this.pfx}/v1/agents/{nid}/verify`,
        ocsp: `${o.baseUrl}${this.pfx}/v1/agents/{nid}/verify`,
        node_ocsp: `${o.baseUrl}${this.pfx}/v1/nodes/{nid}/verify`,
        crl: `${o.baseUrl}${this.pfx}/v1/crl`,
      },
      capabilities: ["agent", "node", "orchestrator-group", `ra-tier-${o.enrollmentTier}`],
      max_cert_validity_days: o.agentCertValidityDays,
    };
    return json(stripNulls(body));
  }

  private async crl(): Promise<Response> {
    const revoked = await this.ca.getCrl();
    const entries = revoked.map((r) => ({
      nid: r.nid,
      serial: r.serial,
      revoked_at: r.revokedAt ? this.ca.formatIso(r.revokedAt) : undefined,
      reason: r.revokeReason,
    }));
    const body = { issued_by: this.opts.caNid, issued_at: this.ca.isoNow(), entries };
    return json(stripNulls({ ...body, signature: this.ca.signArtifact(body) }));
  }

  // ── Registration ─────────────────────────────────────────────────────────

  private async register(req: Request, entityType: "agent" | "node"): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    const body = await readJson<RegisterRequest>(req);
    if (body === undefined) return badRequest("Invalid JSON body.");

    const err = validateRegisterRequest(body);
    if (err) return badRequest(err);

    const enrollToken = req.headers.get("X-NPS-Enrollment-Token") ?? undefined;
    const defaultCaps = entityType === "node" ? ["nwp:query", "nwp:stream"] : [];
    try {
      const frame = await this.ca.registerWithRa(
        entityType,
        body.identifier!,
        body.pub_key!,
        body.capabilities ?? defaultCaps,
        body.scope_json ?? "{}",
        body.metadata_json,
        enrollToken,
        this.enrollmentPolicy,
      );
      return json(frame, 201);
    } catch (e) {
      if (e instanceof NipRaPendingException) return json({ pending_id: e.pendingId, status: "queued" }, 202);
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async registerX509(req: Request, entityType: "agent" | "node"): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    const body = await readJson<RegisterX509Request>(req);
    if (body === undefined) return badRequest("Invalid JSON body.");

    const err = validateRegisterRequest(body);
    if (err) return badRequest(err);

    const defaultCaps = entityType === "node" ? ["nwp:query", "nwp:stream"] : [];
    try {
      const frame = await this.ca.registerX509(
        entityType,
        body.identifier!,
        body.pub_key!,
        body.capabilities ?? defaultCaps,
        body.scope_json ?? "{}",
        Array.isArray(body.cert_chain) ? body.cert_chain : [],
        parseAssuranceLevel(body.assurance_level),
        body.metadata_json,
      );
      return json(frame, 201);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async registerGroup(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    const body = await readJson<RegisterGroupRequest>(req);
    if (body === undefined) return badRequest("Invalid JSON body.");

    if (body.identifier && !IDENTIFIER_RE.test(body.identifier))
      return badRequest("identifier contains invalid characters. Allowed: a-z A-Z 0-9 . _ : @ / -");
    if (!body.pub_key || !body.pub_key.startsWith("ed25519:") || body.pub_key.length <= 8)
      return badRequest("pub_key must be 'ed25519:<base64url>'.");

    try {
      const frame = await this.ca.registerGroup(
        body.identifier,
        body.pub_key,
        body.capabilities ?? [],
        body.scope_json ?? "{}",
        body.owner_user_id,
        body.owner_key_id,
        body.metadata_json,
      );
      return json(frame, 201);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  // ── Issue session ─────────────────────────────────────────────────────────

  private async issueSession(req: Request, groupNid: string): Promise<Response> {
    const ctype = req.headers.get("content-type") ?? "";
    const isJwsBody = ctype.toLowerCase().includes("jose+json");

    let sessionPubKey: string | undefined;
    let purpose: string | null | undefined;
    let validitySeconds: number | null | undefined;
    let capabilities: readonly string[] | null | undefined;
    let scopeJson: string | null | undefined;
    let metadataJson: string | null | undefined;

    if (isJwsBody) {
      const jws = await readJson<GroupJws.FlattenedJws>(req);
      if (jws === undefined) return badRequest("Invalid JWS body.");

      const groupRecord = await this.ca.getCert(groupNid);
      if (!groupRecord)
        return this.errorResult(new NipCaException(`Group ${groupNid} not found.`, NipErrorCodes.ParentNotFound));
      if (groupRecord.nidRole !== NID_ROLE_GROUP)
        return this.errorResult(new NipCaException(`NID ${groupNid} is not a group.`, NipErrorCodes.ParentNotGroup));
      if (groupRecord.revokedAt)
        return this.errorResult(new NipCaException(`Group ${groupNid} revoked.`, NipErrorCodes.GroupRevoked));

      const pubKey = decodePublicKey(groupRecord.pubKey);
      if (!pubKey) return json({ error_code: CA_JWS_INVALID, message: "Group public key could not be decoded." }, 401);

      const result = GroupJws.tryVerify(jws, pubKey);
      if (!result.ok) return json({ error_code: result.errorCode, message: "Group-JWS verification failed." }, 401);
      if (result.kid !== groupNid)
        return json({ error_code: CA_JWS_INVALID, message: `JWS kid '${result.kid}' does not match URL group_nid '${groupNid}'.` }, 401);

      let payload: IssueSessionPayload;
      try {
        payload = JSON.parse(result.payloadJson!) as IssueSessionPayload;
      } catch {
        return json({ error_code: CA_JWS_INVALID, message: "JWS payload is not valid JSON." }, 401);
      }
      if (!payload) return json({ error_code: CA_JWS_INVALID, message: "JWS payload missing." }, 401);

      const skewSec = Math.floor(this.opts.sessionJwsClockSkewMs / 1000);
      const nowEpoch = Math.floor(Date.now() / 1000);
      const iat = payload.iat ?? 0;
      if (iat === 0 || Math.abs(nowEpoch - iat) > skewSec)
        return json({ error_code: CA_JWS_EXPIRED, message: `JWS iat outside ±${skewSec}s window.` }, 401);

      sessionPubKey = payload.session_pub_key;
      purpose = payload.purpose;
      validitySeconds = payload.validity_seconds;
      capabilities = payload.capabilities;
      scopeJson = payload.scope_json;
      metadataJson = payload.metadata_json;
    } else {
      if (!this.isAuthorized(req)) return this.unauthorized();
      const body = await readJson<IssueSessionRequest>(req);
      if (body === undefined) return badRequest("Invalid JSON body.");
      sessionPubKey = body.session_pub_key;
      purpose = body.purpose;
      validitySeconds = body.validity_seconds;
      capabilities = body.capabilities;
      scopeJson = body.scope_json;
      metadataJson = body.metadata_json;
    }

    if (!sessionPubKey || !sessionPubKey.startsWith("ed25519:") || sessionPubKey.length <= 8)
      return badRequest("session_pub_key must be 'ed25519:<base64url>'.");

    const validityMs = validitySeconds && validitySeconds > 0 ? validitySeconds * 1000 : null;

    try {
      const frame = await this.ca.issueSession(
        groupNid, sessionPubKey, validityMs, purpose, capabilities, scopeJson, metadataJson,
      );
      return json(frame, 201);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async listSessions(req: Request, groupNid: string): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    const sessions = await this.ca.listSessions(groupNid);
    return json({
      group_nid: groupNid,
      count: sessions.length,
      sessions: sessions.map((s) => ({
        nid: s.nid,
        serial: s.serial,
        issued_at: this.ca.formatIso(s.issuedAt),
        expires_at: this.ca.formatIso(s.expiresAt),
        revoked_at: s.revokedAt ? this.ca.formatIso(s.revokedAt) : undefined,
        revoke_reason: s.revokeReason,
      })),
    });
  }

  // ── Renew / revoke / verify ────────────────────────────────────────────────

  private async renew(req: Request, nid: string): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    try {
      const frame = await this.ca.renew(nid);
      return json(frame);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async revoke(req: Request, nid: string): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    const body = await readJson<RevokeRequest>(req);
    const reason = body?.reason ?? "cessation_of_operation";
    if (!VALID_REVOCATION_REASONS.has(reason))
      return badRequest(`Invalid revocation reason '${reason}'. Allowed: ${[...VALID_REVOCATION_REASONS].join(", ")}.`);
    try {
      const frame = await this.ca.revoke(nid, reason);
      return json(frame);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async verify(nid: string): Promise<Response> {
    const r = await this.verifyWithTiming(nid);
    if (r.valid)
      return json({
        valid: true,
        nid: r.record!.nid,
        expires_at: this.ca.formatIso(r.record!.expiresAt),
        serial: r.record!.serial,
      });
    const statusCode = r.errorCode === NipErrorCodes.NidNotFound ? 404 : 200;
    return json({ valid: false, error_code: r.errorCode, message: r.message }, statusCode);
  }

  private async verifyWithTiming(nid: string) {
    if (!this.opts.normalizeOcspResponseTime) return this.ca.verify(nid);
    const start = Date.now();
    const result = await this.ca.verify(nid);
    const delay = 200 - (Date.now() - start);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return result;
  }

  // ── Enrollment ─────────────────────────────────────────────────────────────

  private async createToken(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    if (!this.deps.bootstrapTokenStore)
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: "Bootstrap token enrollment is not enabled on this CA." }, 400);

    const body = await readJson<CreateTokenRequest>(req);
    let ttlMs = body?.ttl_seconds && body.ttl_seconds > 0 ? body.ttl_seconds * 1000 : this.opts.bootstrapTokenMaxTtlMs;
    if (ttlMs > this.opts.bootstrapTokenMaxTtlMs) ttlMs = this.opts.bootstrapTokenMaxTtlMs;

    const expiresAt = new Date(Date.now() + ttlMs);
    const raw = await this.deps.bootstrapTokenStore.create(body?.label, expiresAt);
    return json({ token: raw, expires_at: this.ca.formatIso(expiresAt), label: body?.label ?? null }, 201);
  }

  private async listPending(req: Request): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    if (!this.deps.pendingStore)
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: "Pending-queue enrollment is not enabled on this CA." }, 400);

    const records = await this.deps.pendingStore.list();
    const items = records.map((r) => ({
      id: r.id,
      entity_type: r.entityType,
      identifier: r.identifier,
      pub_key: r.pubKey,
      capabilities: r.capabilities,
      scope_json: r.scopeJson,
      requested_at: this.ca.formatIso(r.requestedAt),
      status: PendingStatus[r.status].toLowerCase(),
      reject_reason: r.rejectReason,
    }));
    return json({ count: records.length, items });
  }

  private async approvePending(req: Request, id: string): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    if (!this.deps.pendingStore)
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: "Pending-queue enrollment is not enabled on this CA." }, 400);

    const record = await this.deps.pendingStore.get(id);
    if (!record)
      return json({ error_code: NipErrorCodes.NidNotFound, message: `Pending registration '${id}' not found.` }, 404);
    if (record.status !== PendingStatus.Pending)
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: `Record '${id}' is already ${PendingStatus[record.status]}.` }, 409);

    try {
      const frame = await this.ca.register(
        record.entityType, record.identifier, record.pubKey, record.capabilities, record.scopeJson, record.metadataJson,
      );
      await this.deps.pendingStore.approve(id);
      return json(frame, 201);
    } catch (e) {
      if (e instanceof NipCaException) return this.errorResult(e);
      throw e;
    }
  }

  private async rejectPending(req: Request, id: string): Promise<Response> {
    if (!this.isAuthorized(req)) return this.unauthorized();
    if (!this.deps.pendingStore)
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: "Pending-queue enrollment is not enabled on this CA." }, 400);

    const body = await readJson<RejectPendingRequest>(req);
    const reason = body?.reason ?? "rejected_by_operator";

    const ok = await this.deps.pendingStore.reject(id, reason);
    if (!ok) {
      const record = await this.deps.pendingStore.get(id);
      const msg = !record ? `Pending registration '${id}' not found.` : `Record '${id}' is already ${PendingStatus[record.status]}.`;
      return json({ error_code: "NIP-CA-BAD-REQUEST", message: msg }, record ? 409 : 404);
    }
    return json({ id, status: "rejected", reason });
  }

  // ── Auth / error mapping ────────────────────────────────────────────────────

  private isAuthorized(req: Request): boolean {
    if (this.opts.operatorApiKey === null) return true;
    const header = req.headers.get("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) return false;
    const provided = header.slice("bearer ".length).trim();
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(this.opts.operatorApiKey, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private errorResult(ex: NipCaException): Response {
    const status = errorStatus(ex.errorCode);
    return json({ error_code: ex.errorCode, message: ex.message }, status);
  }

  private unauthorized(): Response {
    return json({ error_code: "NIP-CA-UNAUTHORIZED", message: "Valid operator Bearer token required." }, 401);
  }
}

// ── Free helpers ────────────────────────────────────────────────────────────────

function errorStatus(code: string): number {
  switch (code) {
    case NipErrorCodes.NidNotFound:
    case NipErrorCodes.ParentNotFound:
      return 404;
    case NipErrorCodes.NidAlreadyExists:
      return 409;
    case NipErrorCodes.RenewalTooEarly:
    case NipErrorCodes.SessionValidityInvalid:
    case NipErrorCodes.ParentNotGroup:
      return 400;
    case NipErrorCodes.ScopeExpansion:
    case NipErrorCodes.CertCapMissing:
    case NipErrorCodes.GroupRevoked:
    case RA_NID_NOT_ALLOWED:
    case RA_PENDING_REJECTED:
      return 403;
    case CA_JWS_INVALID:
    case CA_JWS_EXPIRED:
    case NipErrorCodes.CertExpired:
    case NipErrorCodes.CertRevoked:
    case NipErrorCodes.ParentRevoked:
    case RA_TOKEN_INVALID:
    case RA_TOKEN_EXPIRED:
      return 401;
    default:
      return 400;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function badRequest(msg: string): Response {
  return json({ error_code: "NIP-CA-BAD-REQUEST", message: msg }, 400);
}

async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    const text = await req.text();
    if (text.length === 0) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Match `<prefix><segment><suffix>` and return the decoded middle segment, or null. */
function matchPath(path: string, prefix: string, suffix: string): string | null {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const middle = path.slice(prefix.length, path.length - suffix.length);
  if (middle.length === 0 || middle.includes("/")) return null;
  return middle;
}

function validateRegisterRequest(req: { identifier?: string; pub_key?: string }): string | null {
  if (!req.identifier || !req.pub_key) return "identifier and pub_key are required.";
  if (!IDENTIFIER_RE.test(req.identifier))
    return "identifier contains invalid characters. Allowed: a-z A-Z 0-9 . _ : @ / -";
  if (!req.pub_key.startsWith("ed25519:") || req.pub_key.length <= 8) return "pub_key must be 'ed25519:<base64url>'.";
  return null;
}

function parseAssuranceLevel(raw?: string | null): string {
  switch (raw?.toLowerCase()) {
    case "attested":
      return "attested";
    case "verified":
      return "verified";
    default:
      return "anonymous";
  }
}

function stripNulls<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

// ── Request DTOs (wire snake_case) ──────────────────────────────────────────────

interface RegisterRequest {
  identifier?: string;
  pub_key?: string;
  capabilities?: readonly string[];
  scope_json?: string;
  metadata_json?: string | null;
}

interface RegisterX509Request extends RegisterRequest {
  assurance_level?: string;
  cert_chain?: readonly string[];
}

interface RegisterGroupRequest {
  identifier?: string;
  pub_key?: string;
  capabilities?: readonly string[];
  scope_json?: string;
  metadata_json?: string | null;
  owner_user_id?: string | null;
  owner_key_id?: string | null;
}

interface RevokeRequest {
  reason?: string;
}

interface IssueSessionRequest {
  session_pub_key?: string;
  purpose?: string | null;
  validity_seconds?: number | null;
  capabilities?: readonly string[] | null;
  scope_json?: string | null;
  metadata_json?: string | null;
}

interface IssueSessionPayload extends IssueSessionRequest {
  iat?: number;
}

interface CreateTokenRequest {
  ttl_seconds?: number | null;
  label?: string | null;
}

interface RejectPendingRequest {
  reason?: string;
}

export type { CaIdentFrame };
