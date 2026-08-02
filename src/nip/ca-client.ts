// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

export interface NipCaRegisterRequest {
  identifier:   string;
  pub_key:      string;
  capabilities?: readonly string[];
  scope_json?:    string | null;
  metadata_json?: string | null;
}

export interface NipCaRegisterX509Request extends NipCaRegisterRequest {
  assurance_level?: string | null;
}

export interface NipCaIdentFrame {
  frame?:       string;
  nid:          string;
  pub_key:      string;
  capabilities?: readonly string[];
  scope?:        unknown;
  issued_by?:    string;
  issued_at?:    string;
  expires_at?:   string;
  serial?:       string;
  signature?:    string;
  cert_format?:  string;
  cert_chain?:   readonly string[];
  ocsp_staple?:  string;
  [key: string]: unknown;
}

export interface NipCaCrlEntry {
  nid:         string;
  serial:      string;
  revoked_at?: string | null;
  reason?:     string | null;
}

export interface NipCaCrl {
  issued_by: string;
  issued_at: string;
  entries:   readonly NipCaCrlEntry[];
  signature: string;
}

export interface NipCaCertificateRecord {
  nid: string;
  entity_type: string;
  serial: string;
  pub_key: string;
  capabilities: readonly string[];
  scope: unknown;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
  nid_role?: string | null;
  parent_nid?: string | null;
}

export interface NipCaCertificateList {
  entries: readonly NipCaCertificateRecord[];
}

export interface NipCaRevokeFrame {
  frame?:       string;
  target_nid?:  string;
  nid?:         string;
  serial?:      string;
  reason?:      string;
  revoked_at?:  string;
  signature?:   string;
  [key: string]: unknown;
}

export interface NipCaDiscoveryDocument {
  nps_ca:                  string;
  issuer:                  string;
  public_key:              string;
  display_name?:           string;
  algorithms?:             readonly string[];
  endpoints?:              Record<string, unknown>;
  capabilities?:           readonly string[];
  max_cert_validity_days?: number;
}

export interface NipCaVerifyResponse {
  valid:       boolean;
  nid?:        string;
  expires_at?: string;
  serial?:     string;
  error_code?: string;
  message?:    string;
}

export class NipCaClientError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NipCaClientError";
  }
}

export class NipCaClient {
  private readonly baseUrl: string;
  private readonly prefix: string;

  constructor(baseUrl: string, options: { routePrefix?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.prefix  = (options.routePrefix ?? "").replace(/\/$/, "");
  }

  getDiscovery(): Promise<NipCaDiscoveryDocument> {
    return this.getJson<NipCaDiscoveryDocument>("/.well-known/nps-ca");
  }

  getCrl(): Promise<NipCaCrl> {
    return this.getJson<NipCaCrl>(`${this.prefix}/v1/crl`);
  }

  getCertificates(bearerToken?: string): Promise<NipCaCertificateList> {
    return this.sendJson<NipCaCertificateList>(
      "GET", `${this.prefix}/v1/certificates`, undefined, bearerToken);
  }

  static verifyCrlSignature(crl: NipCaCrl, caPublicKey: string): boolean {
    try {
      const publicKey = decodeEd25519(caPublicKey);
      const signature = decodeEd25519(crl.signature);
      const body = {
        issued_by: crl.issued_by,
        issued_at: crl.issued_at,
        entries: crl.entries,
      };
      return ed25519.verify(
        signature,
        new TextEncoder().encode(sortKeysStringify(body)),
        publicKey,
      );
    } catch {
      return false;
    }
  }

  registerAgent(request: NipCaRegisterRequest, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/agents/register`, request, bearerToken);
  }

  registerNode(request: NipCaRegisterRequest, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/nodes/register`, request, bearerToken);
  }

  registerAgentX509(request: NipCaRegisterX509Request, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/agents/register-x509`, request, bearerToken);
  }

  registerNodeX509(request: NipCaRegisterX509Request, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/nodes/register-x509`, request, bearerToken);
  }

  renewAgent(nid: string, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/agents/${encodeURIComponent(nid)}/renew`, undefined, bearerToken);
  }

  renewNode(nid: string, bearerToken?: string): Promise<NipCaIdentFrame> {
    return this.sendJson<NipCaIdentFrame>("POST", `${this.prefix}/v1/nodes/${encodeURIComponent(nid)}/renew`, undefined, bearerToken);
  }

  revokeAgent(
    nid: string,
    reason = "cessation_of_operation",
    bearerToken?: string,
  ): Promise<NipCaRevokeFrame> {
    return this.sendJson<NipCaRevokeFrame>(
      "POST",
      `${this.prefix}/v1/agents/${encodeURIComponent(nid)}/revoke`,
      { reason },
      bearerToken,
    );
  }

  revokeNode(
    nid: string,
    reason = "cessation_of_operation",
    bearerToken?: string,
  ): Promise<NipCaRevokeFrame> {
    return this.sendJson<NipCaRevokeFrame>(
      "POST",
      `${this.prefix}/v1/nodes/${encodeURIComponent(nid)}/revoke`,
      { reason },
      bearerToken,
    );
  }

  verifyAgent(nid: string): Promise<NipCaVerifyResponse> {
    return this.getJson<NipCaVerifyResponse>(`${this.prefix}/v1/agents/${encodeURIComponent(nid)}/verify`);
  }

  verifyNode(nid: string): Promise<NipCaVerifyResponse> {
    return this.getJson<NipCaVerifyResponse>(`${this.prefix}/v1/nodes/${encodeURIComponent(nid)}/verify`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { "Accept": "application/json" },
    });
    return readJsonResponse<T>(response);
  }

  private async sendJson<T>(
    method: string,
    path: string,
    body?: unknown,
    bearerToken?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (bearerToken !== undefined && bearerToken !== "") headers["Authorization"] = `Bearer ${bearerToken}`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return readJsonResponse<T>(response);
  }
}

function decodeEd25519(encoded: string): Uint8Array {
  if (!encoded.startsWith("ed25519:")) throw new Error("Invalid Ed25519 value.");
  const body = encoded.slice("ed25519:".length);
  if (/^[0-9a-fA-F]{64}$/.test(body)) {
    return new Uint8Array(Buffer.from(body, "hex"));
  }
  return new Uint8Array(Buffer.from(body, "base64url"));
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>;
  if (response.ok) return data as T;

  throw new NipCaClientError(
    (data["error_code"] ?? data["error"] ?? "NIP-CA-HTTP-ERROR") as string,
    (data["message"] ?? `NIP CA returned HTTP ${response.status}.`) as string,
    response.status,
  );
}
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sortKeysStringify } from "../core/canonical-json.js";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));
