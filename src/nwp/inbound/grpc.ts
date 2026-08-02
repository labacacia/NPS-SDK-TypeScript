// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Inbound **gRPC** server surface of a Bridge Node (NWP §2.1 inbound profile, §16.1.2).
 *
 * This is the *service logic* of the `NwpIngress` contract (`Protos/nwp_ingress.proto`,
 * package `labacacia.grpc_ingress.v1`) that `LabAcacia.GrpcIngress` published: the four unary
 * RPC handlers over the backend abstraction, backend resolution, and the §16.3 status
 * mapping.
 *
 * **No transport binding.** This SDK has no gRPC or protobuf dependency, and NPS-CR-0010 does
 * not justify adding one, so requests and responses are the plain JSON-shaped structs below
 * and failures are raised as {@link GrpcStatusError}. Bind it to `@grpc/grpc-js` (or any other
 * server) by adapting each handler and translating `GrpcStatusError.code`/`.details` onto that
 * library's status object — the mapping decisions all live here.
 *
 * What changed versus the old ingress is the error mapping: it collapsed 401 and 403 both onto
 * PERMISSION_DENIED and every 5xx onto UNAVAILABLE. §16.3 forbids collapsing distinct NPS
 * status classes, so this implementation maps through the shared {@link BridgeErrorMap} — the
 * same table the MCP and A2A surfaces use, in both directions.
 */

import { NpsStatusCodes } from "../../core/status-codes.js";
import { NwpNodeRole, type INwpBackend, type NwpResult } from "./backend.js";
import { BridgeErrorCodes, toGrpcStatus } from "./error-map.js";
import {
  resolveBridgeInboundOptions,
  servesInbound,
  type BridgeInboundOptions,
  type ResolvedBridgeInboundOptions,
} from "./options.js";

/** `UpstreamContext { upstream = 1; agent_nid = 2; idempotency_key = 3; traceparent = 4; }` */
export interface UpstreamContext {
  upstream?: string;
  agent_nid?: string;
  idempotency_key?: string;
  traceparent?: string;
}

export interface ManifestRequest { ctx?: UpstreamContext }
export interface ManifestResponse { nwm_json: string; node_type: string }

export interface ActionsRequest { ctx?: UpstreamContext }
export interface ActionsResponse { actions_json: string }

export interface InvokeRequest { ctx?: UpstreamContext; action_id: string; params_json?: string }
export interface InvokeResponse { http_status: number; body_json: string; task_id: string }

export interface QueryRequest { ctx?: UpstreamContext; query_json?: string }
export interface QueryResponse { http_status: number; body_json: string }

/**
 * A gRPC status raised by the inbound service. `code` is the canonical `UPPER_SNAKE` status
 * name; `details` carries `"{npsStatus} {nwpError}: {message}"` so a caller can recover the
 * exact NPS fault, not only the coarse gRPC class.
 */
export class GrpcStatusError extends Error {
  constructor(public readonly code: string, public readonly details: string) {
    super(`${code}: ${details}`);
    this.name = "GrpcStatusError";
  }
}

export class GrpcInboundService {
  private readonly options: ResolvedBridgeInboundOptions;

  constructor(
    options: BridgeInboundOptions,
    private readonly backends: readonly INwpBackend[],
  ) {
    this.options = resolveBridgeInboundOptions(options);
  }

  async getManifest(request: ManifestRequest, signal?: AbortSignal): Promise<ManifestResponse> {
    const backend = await this.resolve(request.ctx, signal);
    const descriptor = await backend.getDescriptor(signal);
    const manifest = await backend.getManifest(signal);
    ensure(manifest);
    return {
      nwm_json: JSON.stringify(manifest.payload ?? {}),
      node_type: descriptor.role === NwpNodeRole.UNKNOWN ? "" : descriptor.role,
    };
  }

  async listActions(request: ActionsRequest, signal?: AbortSignal): Promise<ActionsResponse> {
    const backend = await this.resolve(request.ctx, signal);
    const actions = await backend.getActions(signal);
    const body: Record<string, unknown> = {};
    for (const a of actions) body[a.actionId] = { description: a.description };
    return { actions_json: JSON.stringify({ actions: body }) };
  }

  async invoke(request: InvokeRequest, signal?: AbortSignal): Promise<InvokeResponse> {
    if (!request.action_id) {
      throw new GrpcStatusError("INVALID_ARGUMENT", "action_id is required");
    }
    const backend = await this.resolve(request.ctx, signal);
    const args = request.params_json ? JSON.parse(request.params_json) as unknown : null;

    // Always `async: false` — the unary contract has no polling surface.
    const result = await backend.invoke(request.action_id, args, false, signal);
    ensure(result);

    return {
      http_status: 200,
      body_json: JSON.stringify(result.payload ?? {}),
      task_id: tryReadString(result.payload, "task_id") ?? "",
    };
  }

  async query(request: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
    const backend = await this.resolve(request.ctx, signal);
    const query = request.query_json ? JSON.parse(request.query_json) as unknown : {};
    const result = await backend.query(query, signal);
    ensure(result);
    return { http_status: 200, body_json: JSON.stringify(result.payload ?? {}) };
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  /**
   * Backend resolution: if `ctx.upstream` is empty **and exactly one** backend is configured,
   * use it; otherwise match `descriptor.name` case-insensitively.
   */
  private async resolve(ctx: UpstreamContext | undefined, signal?: AbortSignal): Promise<INwpBackend> {
    if (!servesInbound(this.options, "grpc")) {
      throw new GrpcStatusError("UNIMPLEMENTED",
        `${NpsStatusCodes.NPS_SERVER_UNSUPPORTED} ${BridgeErrorCodes.DIRECTION_UNSUPPORTED}: ` +
        'this Bridge Node does not declare "grpc" in bridge_inbound_protocols.');
    }

    const name = ctx?.upstream;
    for (const backend of this.backends) {
      const descriptor = await backend.getDescriptor(signal);
      if (!name && this.backends.length === 1) return backend;
      if (name && descriptor.name.toLowerCase() === name.toLowerCase()) return backend;
    }

    throw new GrpcStatusError("NOT_FOUND",
      `${NpsStatusCodes.NPS_CLIENT_NOT_FOUND} ${BridgeErrorCodes.SERVER_TOOL_NOT_FOUND}: ` +
      `no NWP node named '${name ?? ""}' is fronted by this Bridge Node.`);
  }
}

/**
 * Turn a failed NWP result into a {@link GrpcStatusError} carrying the §16.3 gRPC status.
 * The NPS status and NWP error code travel in the detail.
 */
function ensure(result: NwpResult): void {
  if (result.ok) return;
  let detail = result.npsStatus ?? NpsStatusCodes.NPS_SERVER_INTERNAL;
  if (result.nwpError) detail += ` ${result.nwpError}`;
  if (result.message) detail += `: ${result.message}`;
  throw new GrpcStatusError(toGrpcStatus(result.npsStatus), detail);
}

function tryReadString(payload: unknown, name: string): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const v = (payload as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
}
