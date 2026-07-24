// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NipCaService — core CA business logic: register, issue, renew, revoke,
 * verify (NPS-3 §6–8) plus orchestrator groups / sessions (NPS-CR-0003) and
 * RA-gated enrollment (NPS-CR-0005). Mirrors .NET `NPS.NIP.Ca.NipCaService`.
 *
 * All signing uses the CA's Ed25519 key. The signed IdentFrame payload matches
 * the .NET canonical JCS form exactly: keys `capabilities, expires_at,
 * frame="0x20", issued_at, issued_by, nid, pub_key, scope, serial`, plus
 * `assurance_level` / `lineage` only when set.
 */

import { randomBytes, type KeyObject } from "node:crypto";

import { CERT_CAPABILITY_MISSING } from "../error-codes.js";
import { NipCaException } from "./errors.js";
import {
  EnrollmentTier,
  resolveOptions,
  type NipCaOptions,
  type ResolvedNipCaOptions,
} from "./options.js";
import {
  AllowlistPolicy,
  BootstrapTokenPolicy,
  PendingQueuePolicy,
  type EnrollmentContext,
  type IBootstrapTokenStore,
  type IEnrollmentPolicy,
  type IPendingStore,
} from "./ra/policy.js";
import {
  NID_ROLE_GROUP,
  NID_ROLE_SESSION,
  type INipCaStore,
  type NipCertRecord,
} from "./store.js";
import { NipCaKeyPair, canonicalJson, encodePublicKey, signArtifact } from "./signer.js";

// ── Wire error codes used by the service ────────────────────────────────────────

export const NipErrorCodes = {
  CertExpired: "NIP-CERT-EXPIRED",
  CertRevoked: "NIP-CERT-REVOKED",
  CertCapMissing: CERT_CAPABILITY_MISSING,
  NidNotFound: "NIP-CA-NID-NOT-FOUND",
  NidAlreadyExists: "NIP-CA-NID-ALREADY-EXISTS",
  RenewalTooEarly: "NIP-CA-RENEWAL-TOO-EARLY",
  ScopeExpansion: "NIP-CA-SCOPE-EXPANSION-DENIED",
  GroupRevoked: "NIP-CA-GROUP-REVOKED",
  ParentNotFound: "NIP-CA-PARENT-NOT-FOUND",
  ParentNotGroup: "NIP-CA-PARENT-NOT-GROUP",
  SessionValidityInvalid: "NIP-CA-SESSION-VALIDITY-INVALID",
  ParentRevoked: "NIP-CERT-PARENT-REVOKED",
  CertFormatInvalid: "NIP-CERT-FORMAT-INVALID",
} as const;

// ── Result / frame shapes ───────────────────────────────────────────────────────

/** IdentFrame emitted by the CA (wire JSON shape, snake_case). */
export interface CaIdentFrame {
  frame: string;
  nid: string;
  pub_key: string;
  capabilities: readonly string[];
  scope: unknown;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  serial: string;
  signature: string;
  metadata?: unknown;
  assurance_level?: string;
  lineage?: Record<string, unknown>;
  cert_format?: string;
  cert_chain?: readonly string[];
}

/** RevokeFrame emitted by the CA (wire JSON shape). */
export interface CaRevokeFrame {
  frame: string;
  target_nid: string;
  serial: string;
  reason: string;
  revoked_at: string;
  signer_nid: string;
  signature: string;
}

/** Result of a NIP certificate verification check. */
export interface NipVerifyResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  record?: NipCertRecord;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** ISO-8601 with second/fractional precision matching .NET `DateTime.ToString("O")`. */
function isoRoundTrip(d: Date): string {
  // .NET "O" is like 2026-07-09T12:34:56.7890000Z. JS toISOString gives
  // millisecond precision; we pad to 7 fractional digits for byte-parity of
  // format. Both round-trip; tests compare the emitted string to itself.
  const base = d.toISOString(); // e.g. 2026-07-09T12:34:56.789Z
  const m = base.match(/^(.*)\.(\d{3})Z$/);
  if (!m) return base;
  return `${m[1]}.${m[2]}0000Z`;
}

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

// ── Service ─────────────────────────────────────────────────────────────────────

export class NipCaService {
  private readonly opts: ResolvedNipCaOptions;
  private readonly caPriv: KeyObject;
  private readonly caPub: KeyObject;

  constructor(
    options: NipCaOptions,
    private readonly store: INipCaStore,
    keys: NipCaKeyPair,
  ) {
    this.opts = resolveOptions(options);
    this.caPriv = keys.privateKey;
    this.caPub = keys.publicKey;
  }

  // ── Register (Agent / Node) ───────────────────────────────────────────────

  async register(
    entityType: string,
    identifier: string,
    pubKey: string,
    capabilities: readonly string[],
    scopeJson: string,
    metadataJson?: string | null,
  ): Promise<CaIdentFrame> {
    const nid = this.buildNid(entityType, identifier);
    if (await this.store.getByNid(nid))
      throw new NipCaException(`NID already exists: ${nid}`, NipErrorCodes.NidAlreadyExists);

    this.checkCapabilities(capabilities);

    const validDays = entityType === "node" ? this.opts.nodeCertValidityDays : this.opts.agentCertValidityDays;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validDays * 86_400_000);
    const serial = await this.store.nextSerial();

    const frame = this.issueFrame(nid, pubKey, capabilities, scopeJson, now, expiresAt, serial, metadataJson);

    await this.store.save({
      nid,
      entityType,
      serial,
      pubKey,
      capabilities: [...capabilities],
      scopeJson,
      issuedBy: this.opts.caNid,
      issuedAt: now,
      expiresAt,
      metadataJson,
    });
    return frame;
  }

  // ── Register with RA gate (NPS-CR-0005) ───────────────────────────────────

  async registerWithRa(
    entityType: string,
    identifier: string,
    pubKey: string,
    capabilities: readonly string[],
    scopeJson: string,
    metadataJson?: string | null,
    enrollmentToken?: string | null,
    enrollmentPolicy?: IEnrollmentPolicy | null,
  ): Promise<CaIdentFrame> {
    if (enrollmentPolicy) {
      const ctx: EnrollmentContext = {
        entityType,
        identifier,
        pubKey,
        capabilities,
        scopeJson,
        metadataJson,
        enrollmentToken,
      };
      await enrollmentPolicy.check(ctx);
    }
    return this.register(entityType, identifier, pubKey, capabilities, scopeJson, metadataJson);
  }

  /** Constructs the IEnrollmentPolicy selected by the configured tier. */
  static createEnrollmentPolicy(
    options: NipCaOptions,
    bootstrapTokenStore?: IBootstrapTokenStore | null,
    pendingStore?: IPendingStore | null,
  ): IEnrollmentPolicy {
    const opts = resolveOptions(options);
    switch (opts.enrollmentTier) {
      case EnrollmentTier.Allowlist:
        return new AllowlistPolicy(opts.enrollmentAllowlistPatterns);
      case EnrollmentTier.BootstrapToken:
        if (!bootstrapTokenStore)
          throw new Error("EnrollmentTier.BootstrapToken requires IBootstrapTokenStore to be registered.");
        return new BootstrapTokenPolicy(bootstrapTokenStore);
      case EnrollmentTier.PendingQueue:
        if (!pendingStore)
          throw new Error("EnrollmentTier.PendingQueue requires IPendingStore to be registered.");
        return new PendingQueuePolicy(pendingStore, opts.pendingQueueMaxSize);
      default:
        throw new Error(`Unknown EnrollmentTier: ${opts.enrollmentTier}`);
    }
  }

  // ── Register X.509 (NPS-RFC-0002 prototype) ───────────────────────────────

  /**
   * Registers a new Agent/Node and issues an IdentFrame with both the v1
   * CA-signed proof and a DER-encoded X.509 certificate chain
   * (`cert_format="v2-x509"`). `chain` is the caller-supplied
   * `[leafDerB64Url, rootDerB64Url]`; the assurance level lands in the signed
   * v1 payload and (for the caller building the chain) the X.509 leaf.
   */
  async registerX509(
    entityType: string,
    identifier: string,
    pubKey: string,
    capabilities: readonly string[],
    scopeJson: string,
    chain: readonly string[],
    assuranceLevel: string = "anonymous",
    metadataJson?: string | null,
  ): Promise<CaIdentFrame> {
    if (!pubKey.startsWith("ed25519:"))
      throw new NipCaException(
        `X.509 issuance requires an ed25519:* pubkey; got '${pubKey}'.`,
        NipErrorCodes.CertFormatInvalid,
      );

    const nid = this.buildNid(entityType, identifier);
    if (await this.store.getByNid(nid))
      throw new NipCaException(`NID already exists: ${nid}`, NipErrorCodes.NidAlreadyExists);

    this.checkCapabilities(capabilities);

    const validDays = entityType === "node" ? this.opts.nodeCertValidityDays : this.opts.agentCertValidityDays;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + validDays * 86_400_000);
    const serial = await this.store.nextSerial();

    const v1Frame = this.issueFrame(
      nid, pubKey, capabilities, scopeJson, now, expiresAt, serial, metadataJson, assuranceLevel,
    );

    await this.store.save({
      nid,
      entityType,
      serial,
      pubKey,
      capabilities: [...capabilities],
      scopeJson,
      issuedBy: this.opts.caNid,
      issuedAt: now,
      expiresAt,
      metadataJson,
    });

    return { ...v1Frame, cert_format: "v2-x509", cert_chain: [...chain] };
  }

  // ── Register Group (NPS-CR-0003) ──────────────────────────────────────────

  async registerGroup(
    identifier: string | null | undefined,
    pubKey: string,
    capabilities: readonly string[],
    scopeJson: string,
    ownerUserId?: string | null,
    ownerKeyId?: string | null,
    metadataJson?: string | null,
  ): Promise<CaIdentFrame> {
    let id = identifier ?? "";
    if (!id) {
      id = "group-" + randomBytes(16).toString("hex");
    } else if (!id.startsWith("group-")) {
      throw new NipCaException(
        `Group identifier MUST start with reserved prefix 'group-' (got '${id}'). NPS-3 §3.1.`,
        NipErrorCodes.NidAlreadyExists,
      );
    }

    const nid = this.buildNid("agent", id);
    if (await this.store.getByNid(nid))
      throw new NipCaException(`NID already exists: ${nid}`, NipErrorCodes.NidAlreadyExists);

    this.checkCapabilities(capabilities);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.opts.groupCertValidityDays * 86_400_000);
    const serial = await this.store.nextSerial();

    const lineage = buildLineage({
      role: NID_ROLE_GROUP,
      owner_user_id: ownerUserId,
      owner_key_id: ownerKeyId,
    });
    const lineageJson = canonicalJson(lineage);

    const frame = this.issueFrame(
      nid, pubKey, capabilities, scopeJson, now, expiresAt, serial, metadataJson, undefined, lineage,
    );

    await this.store.save({
      nid,
      entityType: "agent",
      serial,
      pubKey,
      capabilities: [...capabilities],
      scopeJson,
      issuedBy: this.opts.caNid,
      issuedAt: now,
      expiresAt,
      metadataJson,
      nidRole: NID_ROLE_GROUP,
      parentNid: null,
      lineageJson,
    });
    return frame;
  }

  // ── Issue Session (NPS-CR-0003) ───────────────────────────────────────────

  async issueSession(
    groupNid: string,
    sessionPubKey: string,
    validityMs?: number | null,
    purpose?: string | null,
    capabilities?: readonly string[] | null,
    scopeJson?: string | null,
    metadataJson?: string | null,
  ): Promise<CaIdentFrame> {
    // 1. Resolve + validate group
    const group = await this.store.getByNid(groupNid);
    if (!group)
      throw new NipCaException(`Group NID not found: ${groupNid}.`, NipErrorCodes.ParentNotFound);
    if (group.nidRole !== NID_ROLE_GROUP)
      throw new NipCaException(
        `NID '${groupNid}' is not registered as a group (role='${group.nidRole ?? "<null>"}').`,
        NipErrorCodes.ParentNotGroup,
      );
    if (group.revokedAt)
      throw new NipCaException(
        `Group ${groupNid} was revoked; cannot issue new sessions.`,
        NipErrorCodes.GroupRevoked,
      );
    if (new Date() > group.expiresAt)
      throw new NipCaException(
        `Group ${groupNid} expired; cannot issue new sessions.`,
        NipErrorCodes.CertExpired,
      );

    // 2. Validate validity window
    const v = validityMs ?? this.opts.sessionDefaultValidityMs;
    if (v < this.opts.sessionMinValidityMs || v > this.opts.sessionMaxValidityMs)
      throw new NipCaException(
        `Session validity must be in [${this.opts.sessionMinValidityMs}, ${this.opts.sessionMaxValidityMs}] ms; got ${v}.`,
        NipErrorCodes.SessionValidityInvalid,
      );

    // 3. Subset checks (no scope expansion past the group)
    const sessionCaps = capabilities ?? group.capabilities;
    if (capabilities) {
      const groupCapSet = new Set(group.capabilities);
      const expansion = sessionCaps.filter((c) => !groupCapSet.has(c));
      if (expansion.length > 0)
        throw new NipCaException(
          `Session capabilities not in parent group: ${expansion.join(", ")}.`,
          NipErrorCodes.ScopeExpansion,
        );
    }
    const sessionScopeJson = scopeJson ?? group.scopeJson;

    // 4. Build session NID
    const unixSeconds = Math.floor(Date.now() / 1000);
    const sessionId = `session-${unixSeconds}-${randomHex(8)}`;
    const sessionNid = this.buildNid("agent", sessionId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + v);
    const serial = await this.store.nextSerial();

    // 5. Lineage
    const lineage = buildLineage({
      role: NID_ROLE_SESSION,
      parent_nid: groupNid,
      group_nid: groupNid,
      session_id: sessionId,
      purpose,
      owner_user_id: extractLineageString(group.lineageJson, "owner_user_id"),
      owner_key_id: extractLineageString(group.lineageJson, "owner_key_id"),
    });
    const lineageJson = canonicalJson(lineage);

    const frame = this.issueFrame(
      sessionNid, sessionPubKey, sessionCaps, sessionScopeJson, now, expiresAt, serial, metadataJson, undefined, lineage,
    );

    await this.store.save({
      nid: sessionNid,
      entityType: "agent",
      serial,
      pubKey: sessionPubKey,
      capabilities: [...sessionCaps],
      scopeJson: sessionScopeJson,
      issuedBy: this.opts.caNid,
      issuedAt: now,
      expiresAt,
      metadataJson,
      nidRole: NID_ROLE_SESSION,
      parentNid: groupNid,
      lineageJson,
    });
    return frame;
  }

  listSessions(groupNid: string): Promise<readonly NipCertRecord[]> {
    return this.store.getByParentNid(groupNid);
  }

  getCert(nid: string): Promise<NipCertRecord | null> {
    return this.store.getByNid(nid);
  }

  // ── Renew ─────────────────────────────────────────────────────────────────

  async renew(nid: string): Promise<CaIdentFrame> {
    const record = await this.store.getByNid(nid);
    if (!record) throw new NipCaException(`NID not found: ${nid}`, NipErrorCodes.NidNotFound);
    if (record.revokedAt) throw new NipCaException(`NID is revoked: ${nid}`, NipErrorCodes.CertRevoked);

    const now = new Date();
    const renewWindowStart = new Date(record.expiresAt.getTime() - this.opts.renewalWindowDays * 86_400_000);
    if (now < renewWindowStart)
      throw new NipCaException(
        `Renewal window opens ${isoRoundTrip(renewWindowStart)}. Too early to renew.`,
        NipErrorCodes.RenewalTooEarly,
      );

    const validDays = record.entityType === "node" ? this.opts.nodeCertValidityDays : this.opts.agentCertValidityDays;
    const expiresAt = new Date(now.getTime() + validDays * 86_400_000);
    const serial = await this.store.nextSerial();

    const frame = this.issueFrame(
      nid, record.pubKey, record.capabilities, record.scopeJson, now, expiresAt, serial, record.metadataJson,
    );

    await this.store.save({
      nid,
      entityType: record.entityType,
      serial,
      pubKey: record.pubKey,
      capabilities: [...record.capabilities],
      scopeJson: record.scopeJson,
      issuedBy: this.opts.caNid,
      issuedAt: now,
      expiresAt,
      metadataJson: record.metadataJson,
    });
    return frame;
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────

  async revoke(nid: string, reason: string): Promise<CaRevokeFrame> {
    const record = await this.store.getByNid(nid);
    if (!record) throw new NipCaException(`NID not found: ${nid}`, NipErrorCodes.NidNotFound);

    const now = new Date();
    const revoked = await this.store.revoke(nid, reason, now);
    if (!revoked) throw new NipCaException(`Failed to revoke ${nid}.`, NipErrorCodes.NidNotFound);

    // Cascade-revoke live sessions if this is a group.
    if (record.nidRole === NID_ROLE_GROUP) {
      const children = await this.store.getByParentNid(nid);
      for (const child of children) {
        if (child.revokedAt) continue;
        await this.store.revoke(child.nid, "parent_revoked", now);
      }
    }

    const revokedAtStr = isoRoundTrip(now);
    const payload = {
      frame: "0x22",
      target_nid: nid,
      serial: record.serial,
      reason,
      revoked_at: revokedAtStr,
      signer_nid: this.opts.caNid,
    };
    const signature = signArtifact(this.caPriv, payload);

    return {
      frame: "0x22",
      target_nid: nid,
      serial: record.serial,
      reason,
      revoked_at: revokedAtStr,
      signer_nid: this.opts.caNid,
      signature,
    };
  }

  // ── Verify (OCSP) ───────────────────────────────────────────────────────────

  async verify(nid: string): Promise<NipVerifyResult> {
    const record = await this.store.getByNid(nid);
    if (!record) return { valid: false, errorCode: NipErrorCodes.NidNotFound, message: "NID not found." };

    if (record.revokedAt)
      return {
        valid: false,
        errorCode: NipErrorCodes.CertRevoked,
        message: `Revoked at ${isoRoundTrip(record.revokedAt)}: ${record.revokeReason ?? ""}`,
      };

    if (new Date() > record.expiresAt)
      return {
        valid: false,
        errorCode: NipErrorCodes.CertExpired,
        message: `Expired at ${isoRoundTrip(record.expiresAt)}.`,
      };

    // Chain check — NPS-3 §7 step 3a.
    if (record.parentNid) {
      const parent = await this.store.getByNid(record.parentNid);
      if (!parent)
        return { valid: false, errorCode: NipErrorCodes.ParentRevoked, message: `Parent NID ${record.parentNid} not found.` };
      if (parent.revokedAt)
        return { valid: false, errorCode: NipErrorCodes.ParentRevoked, message: `Parent ${record.parentNid} revoked.` };
      if (new Date() > parent.expiresAt)
        return { valid: false, errorCode: NipErrorCodes.ParentRevoked, message: `Parent ${record.parentNid} expired.` };
    }

    return { valid: true, record };
  }

  // ── CRL / listing / signing / key ────────────────────────────────────────

  getCrl(): Promise<readonly NipCertRecord[]> {
    return this.store.getRevoked();
  }

  listCertificates(): Promise<readonly NipCertRecord[]> {
    return this.store.list();
  }

  signArtifact(artifact: unknown): string {
    return signArtifact(this.caPriv, artifact);
  }

  getCaPublicKey(): string {
    const der = this.caPub.export({ type: "spki", format: "der" });
    return encodePublicKey(new Uint8Array(der.subarray(der.length - 32)));
  }

  get resolvedOptions(): ResolvedNipCaOptions {
    return this.opts;
  }

  isoNow(): string {
    return isoRoundTrip(new Date());
  }

  formatIso(d: Date): string {
    return isoRoundTrip(d);
  }

  // ── NID builder ─────────────────────────────────────────────────────────────

  buildNid(entityType: string, identifier: string): string {
    const parts = this.opts.caNid.split(":");
    const domain = parts.length >= 4 ? parts[3] : this.opts.caNid;
    return `urn:nps:${entityType}:${domain}:${identifier}`;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private checkCapabilities(capabilities: readonly string[]): void {
    if (this.opts.allowedCapabilities) {
      const disallowed = capabilities.filter((c) => !this.opts.allowedCapabilities!.has(c));
      if (disallowed.length > 0)
        throw new NipCaException(
          `Capabilities not permitted by this CA: ${disallowed.join(", ")}`,
          NipErrorCodes.CertCapMissing,
        );
    }
  }

  private issueFrame(
    nid: string,
    pubKey: string,
    capabilities: readonly string[],
    scopeJson: string,
    issuedAt: Date,
    expiresAt: Date,
    serial: string,
    metadataJson?: string | null,
    assuranceLevel?: string,
    lineage?: Record<string, unknown>,
  ): CaIdentFrame {
    const scope = JSON.parse(scopeJson) as unknown;
    const issuedAtStr = isoRoundTrip(issuedAt);
    const expiresAtStr = isoRoundTrip(expiresAt);

    // Canonical payload for signing — alphabetical order enforced by
    // canonicalJson. assurance_level and lineage are included only when set.
    const payload: Record<string, unknown> = {
      capabilities,
      expires_at: expiresAtStr,
      frame: "0x20",
      issued_at: issuedAtStr,
      issued_by: this.opts.caNid,
      nid,
      pub_key: pubKey,
      scope,
      serial,
    };
    if (assuranceLevel !== undefined) payload["assurance_level"] = assuranceLevel;
    if (lineage !== undefined) payload["lineage"] = lineage;

    const signature = signArtifact(this.caPriv, payload);

    const frame: CaIdentFrame = {
      frame: "0x20",
      nid,
      pub_key: pubKey,
      capabilities,
      scope,
      issued_by: this.opts.caNid,
      issued_at: issuedAtStr,
      expires_at: expiresAtStr,
      serial,
      signature,
    };
    if (metadataJson != null) frame.metadata = JSON.parse(metadataJson);
    if (assuranceLevel !== undefined) frame.assurance_level = assuranceLevel;
    if (lineage !== undefined) frame.lineage = lineage;
    return frame;
  }
}

// ── Lineage helpers ─────────────────────────────────────────────────────────────

/** Build a lineage object, omitting null/undefined fields (snake_case wire keys). */
function buildLineage(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function extractLineageString(lineageJson: string | null | undefined, field: string): string | null {
  if (!lineageJson) return null;
  try {
    const obj = JSON.parse(lineageJson) as Record<string, unknown>;
    const v = obj[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
