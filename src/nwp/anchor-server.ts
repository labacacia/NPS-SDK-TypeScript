// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS NWP — Anchor Node server (Web-standard Fetch handler, zero deps).
 *
 * Server-side counterpart of {@link AnchorNodeClient}, porting the .NET
 * `AnchorNodeMiddleware` wire contract (NPS-AaaS §2, NPS-2 §12) and mirroring
 * the Python `nps_sdk.nwp.anchor_server`. {@link AnchorNodeApp.fetch} takes a
 * standard `Request` and returns a `Response` — mount it on Node (≥18), Deno,
 * Bun, Cloudflare Workers, or any WHATWG-fetch runtime.
 *
 * The business execution behind `/invoke` is delegated to an injected
 * {@link AnchorInvokeHandler} (NOP orchestration is host-supplied), mirroring
 * how the .NET middleware requires an `IAnchorRouter` + `INopOrchestrator`.
 */

import { AssuranceLevel } from "../nip/assurance-level.js";
import { ActionFrame } from "./frames.js";
import type { AnchorEpochFence, InboundEpochFrame } from "./anchor-epoch.js";
import type {
  MemberChanges,
  MemberInfo,
  TopologyEvent,
  TopologyFilter,
  TopologySnapshot,
} from "./anchor-client.js";
import * as ErrorCodes from "./nwp-error-codes.js";
import * as H from "./http-headers.js";
import {
  RepOutcome,
  type ReputationDecision,
  type ReputationPolicy,
  type IReputationEvaluator,
} from "./reputation.js";

// ── Wire constants (NPS-2 §12) ─────────────────────────────────────────────────

export const TopologyWire = {
  TYPE_SNAPSHOT: "topology.snapshot",
  TYPE_STREAM: "topology.stream",
  SCOPE_CLUSTER: "cluster",
  SCOPE_MEMBER: "member",
  SNAPSHOT_ANCHOR_REF: "nps:system:topology:snapshot",
} as const;

// ── Errors ─────────────────────────────────────────────────────────────────────

export class TopologyProtocolError extends Error {
  constructor(
    public readonly nwpErrorCode: string,
    public readonly npsStatus: string,
    message: string,
  ) {
    super(message);
    this.name = "TopologyProtocolError";
  }
}

export class AnchorActionError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly npsStatus: string,
    public readonly errorCode: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AnchorActionError";
  }
}

// ── Topology request types + service ───────────────────────────────────────────

export interface AnchorSnapshotRequest {
  scope: string;
  include: Set<string>;
  depth: number;
  targetNid?: string;
}

export interface AnchorStreamRequest {
  scope: string;
  filter?: TopologyFilter;
  sinceVersion?: number;
}

export interface AnchorTopologyService {
  readonly anchorNid: string;
  getSnapshot(request: AnchorSnapshotRequest): Promise<TopologySnapshot>;
  subscribe(request: AnchorStreamRequest): AsyncIterable<TopologyEvent>;
}

/** Reference in-memory topology service. */
export class InMemoryAnchorTopologyService implements AnchorTopologyService {
  constructor(
    public readonly anchorNid: string,
    private readonly members: MemberInfo[] = [],
    private readonly version = 1,
    private readonly events: TopologyEvent[] = [],
  ) {}

  async getSnapshot(request: AnchorSnapshotRequest): Promise<TopologySnapshot> {
    const members = request.include.has("members") ? this.members : [];
    return {
      version: this.version,
      anchor_nid: this.anchorNid,
      cluster_size: this.members.length,
      members,
    };
  }

  async *subscribe(_request: AnchorStreamRequest): AsyncIterable<TopologyEvent> {
    for (const ev of this.events) yield ev;
  }
}

// ── Options / handler / rate limiter ───────────────────────────────────────────

export interface AnchorActionSpec {
  description?: string;
  paramsAnchor?: string;
  resultAnchor?: string;
  estimatedCgn?: number;
  timeoutMsDefault?: number;
  timeoutMsMax?: number;
  requiredCapability?: string;
  async_?: boolean;
}

export interface AnchorNodeOptions {
  nodeId: string;
  pathPrefix: string;
  actions: Record<string, AnchorActionSpec>;
  displayName?: string;
  requireAuth?: boolean;
  requiredCapabilities?: string[];
  requireTopologyCapability?: boolean;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultTokenBudget?: number;
  cgnLimit?: number;
  assuranceHintUrl?: string;
  reputationPolicy?: ReputationPolicy;
  trustAnchors?: string[];
  rateLimits?: Record<string, unknown>;
  autoInjectTraceContext?: boolean;
}

export interface InvokeContext {
  agentNid?: string;
  effectiveTimeoutMs: number;
  budgetCgn: number;
  traceId?: string;
  spanId?: string;
}

export type AnchorInvokeHandler = (
  actionId: string,
  frame: ActionFrame,
  ctx: InvokeContext,
) => Promise<unknown>;

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: string;
}

export interface AnchorRateLimiter {
  tryAcquire(consumerKey: string, costHint: number): RateDecision;
  release(consumerKey: string): void;
}

export class AllowAllRateLimiter implements AnchorRateLimiter {
  tryAcquire(): RateDecision {
    return { allowed: true };
  }
  release(): void {
    /* no-op */
  }
}

// ── Serialization helpers ──────────────────────────────────────────────────────

function snapshotToDict(s: TopologySnapshot): Record<string, unknown> {
  // MemberInfo / TopologySnapshot fields are already snake_case wire keys;
  // JSON.stringify drops `undefined` optionals.
  return { ...s } as Record<string, unknown>;
}

function eventToEnvelope(streamId: string, ev: TopologyEvent): Record<string, unknown> {
  let seq: number | undefined;
  let payload: Record<string, unknown>;
  switch (ev.kind) {
    case "member_joined":
      seq = ev.version;
      payload = ev.member as unknown as Record<string, unknown>;
      break;
    case "member_left":
      seq = ev.version;
      payload = { nid: ev.nid };
      break;
    case "member_updated":
      seq = ev.version;
      payload = { nid: ev.nid, changes: ev.changes as unknown as Record<string, unknown> };
      break;
    case "anchor_state":
      seq = ev.version;
      payload = { field: ev.field, details: ev.details };
      break;
    case "resync_required":
      seq = undefined;
      payload = { reason: ev.reason };
      break;
  }
  const raw = JSON.stringify(payload);
  const cgnEst = Math.max(1, Math.floor(new TextEncoder().encode(raw).length / 4));
  const env: Record<string, unknown> = {
    stream_id: streamId,
    event_type: ev.kind,
    timestamp: new Date().toISOString(),
    payload,
    cgn_est: cgnEst,
  };
  if (seq !== undefined) env["seq"] = seq;
  return env;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serialize the (camelCase) reference ReputationPolicy to the snake_case NWM wire form. */
function reputationPolicyToWire(p: ReputationPolicy): Record<string, unknown> {
  const rule = (r: { incident?: string; severity?: string; withinDays?: number; count?: number }) => {
    const d: Record<string, unknown> = { incident: r.incident ?? "*", severity: r.severity ?? ">=minor" };
    if (r.withinDays !== undefined) d["within_days"] = r.withinDays;
    if (r.count !== undefined) d["count"] = r.count;
    return d;
  };
  const out: Record<string, unknown> = {};
  if (p.enabled !== undefined) out["enabled"] = p.enabled;
  if (p.logSources !== undefined) out["log_sources"] = p.logSources;
  if (p.minAssuranceLevel !== undefined) out["min_assurance_level"] = p.minAssuranceLevel;
  if (p.cacheTtlSeconds !== undefined) out["cache_ttl_seconds"] = p.cacheTtlSeconds;
  if (p.banTtlSeconds !== undefined) out["ban_ttl_seconds"] = p.banTtlSeconds;
  if (p.onLogUnavailable !== undefined) out["on_log_unavailable"] = p.onLogUnavailable;
  if (p.throttleOn !== undefined) out["throttle_on"] = p.throttleOn.map(rule);
  if (p.rejectOn !== undefined) out["reject_on"] = p.rejectOn.map(rule);
  if (p.banOn !== undefined) out["ban_on"] = p.banOn.map(rule);
  return out;
}

// ── The Fetch app ──────────────────────────────────────────────────────────────

/** Anchor sub-paths the node serves; an unknown sub-path is a 404, not a 401. */
const KNOWN_ROUTES = new Set<string>([
  "/.nwm", "/.nwm/", "/.schema", "/.schema/", "/actions", "/actions/",
  "/invoke", "/invoke/", "/query", "/query/", "/subscribe", "/subscribe/",
]);

export interface AnchorNodeAppDeps {
  invokeHandler?: AnchorInvokeHandler;
  topologyService?: AnchorTopologyService;
  reputationEvaluator?: IReputationEvaluator;
  rateLimiter?: AnchorRateLimiter;
  /**
   * NPS-CR-0009 — cluster ownership state. When supplied, every inbound request passes the
   * epoch fence first, `/invoke` additionally passes the leader check (it is this Anchor's
   * only topology-mutating path), and every topology response is stamped with the current
   * `cluster_epoch` per NWP §12.2. Omit it for a single-Anchor deployment.
   */
  epochFence?: AnchorEpochFence;
}

/** HTTP status for a topology-layer NPS status (spec/status-codes.md). */
function topologyHttpStatus(npsStatus: string): number {
  switch (npsStatus) {
    case "NPS-AUTH-FORBIDDEN":  return 403;
    case "NPS-CLIENT-CONFLICT": return 409;
    default:                    return 400;
  }
}

/**
 * The `cluster_epoch` an inbound request claims. Carried either in the request body
 * (`cluster_epoch` / `sender_anchor_nid`) or in the `X-NWP-Cluster-Epoch` /
 * `X-NWP-Anchor-Nid` headers, so that a bodiless request can still be fenced.
 */
function readInboundEpoch(req: Request, body?: Record<string, unknown>): InboundEpochFrame {
  const bodyEpoch = body?.["cluster_epoch"];
  const headerEpoch = req.headers.get(H.HDR_CLUSTER_EPOCH);
  const epoch = typeof bodyEpoch === "number"
    ? bodyEpoch
    : headerEpoch !== null && headerEpoch !== "" && !Number.isNaN(Number(headerEpoch))
      ? Number(headerEpoch)
      : undefined;
  const bodyNid = body?.["sender_anchor_nid"];
  const sender = typeof bodyNid === "string" ? bodyNid : req.headers.get(H.HDR_ANCHOR_NID) ?? undefined;
  return { cluster_epoch: epoch, sender_anchor_nid: sender };
}

export class AnchorNodeApp {
  private readonly opt: Required<Pick<AnchorNodeOptions, "requireAuth" | "requireTopologyCapability"
    | "defaultTimeoutMs" | "maxTimeoutMs" | "defaultTokenBudget" | "cgnLimit" | "autoInjectTraceContext">>
    & AnchorNodeOptions;
  private readonly prefix: string;
  private readonly handler?: AnchorInvokeHandler;
  private readonly topology?: AnchorTopologyService;
  private readonly evaluator?: IReputationEvaluator;
  private readonly fence?: AnchorEpochFence;
  private readonly limiter: AnchorRateLimiter;
  private readonly nwmJson: string;
  private readonly actionsJson: string;

  constructor(options: AnchorNodeOptions, deps: AnchorNodeAppDeps = {}) {
    this.opt = {
      requireAuth: true,
      requireTopologyCapability: false,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 300_000,
      defaultTokenBudget: 0,
      cgnLimit: 0,
      autoInjectTraceContext: true,
      ...options,
    };
    this.prefix = options.pathPrefix.replace(/\/+$/, "");
    this.handler = deps.invokeHandler;
    this.topology = deps.topologyService;
    this.evaluator = deps.reputationEvaluator;
    this.fence = deps.epochFence;
    this.limiter = deps.rateLimiter ?? new AllowAllRateLimiter();
    this.nwmJson = JSON.stringify(this.buildManifest());
    this.actionsJson = JSON.stringify({ actions: this.actionsDict() });
  }

  /** WHATWG Fetch handler. */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith(this.prefix)) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
        "no NWP node at this path.");
    }
    const sub = path.slice(this.prefix.length);

    // Resolve the route BEFORE the auth gate: an unknown sub-path is a 404 regardless of auth, so
    // a missing X-NWP-Agent on a non-existent route does not leak a 401 (auth state) for a path
    // that has no resource. Known routes fall through to the auth check below.
    if (!KNOWN_ROUTES.has(sub)) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
        "unknown anchor sub-path.");
    }

    if (this.opt.requireAuth && !req.headers.get(H.HDR_AGENT)) {
      return this.errorResponse(401, "NPS-AUTH-UNAUTHENTICATED", ErrorCodes.NWP_AUTH_NID_SCOPE_VIOLATION,
        "X-NWP-Agent header is required.");
    }

    switch (true) {
      case sub === "/.nwm" || sub === "/.nwm/":
        return new Response(this.nwmJson, {
          status: 200,
          headers: { "content-type": H.MIME_MANIFEST, [H.HDR_NODE_TYPE.toLowerCase()]: "anchor" },
        });
      case sub === "/.schema" || sub === "/.schema/" || sub === "/actions" || sub === "/actions/":
        return new Response(this.actionsJson, { status: 200, headers: { "content-type": "application/json" } });
      case sub === "/invoke" || sub === "/invoke/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleInvoke(req);
      case sub === "/query" || sub === "/query/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleQuery(req);
      case sub === "/subscribe" || sub === "/subscribe/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleSubscribe(req);
      default:
        return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
          "unknown anchor sub-path.");
    }
  };

  // ── /query ───────────────────────────────────────────────────────────────────

  private async handleQuery(req: Request): Promise<Response> {
    const capCheck = this.checkTopologyCapability(req);
    if (capCheck) return capCheck;

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_QUERY_FILTER_INVALID, String(e));
    }

    // NPS-CR-0009 §3.2(a): the epoch fence runs first, on any inbound frame — reads included.
    const fenced = this.applyFence(req, body, false);
    if (fenced) return fenced;

    if (body["type"] !== TopologyWire.TYPE_SNAPSHOT) {
      const t = body["type"];
      return this.errorResponse(501, "NPS-SERVER-UNSUPPORTED", ErrorCodes.NWP_RESERVED_TYPE_UNSUPPORTED,
        t == null ? "Anchor /query requires a reserved type per NPS-2 §12."
          : `Reserved query type '${String(t)}' is not implemented by this Anchor Node.`);
    }
    if (!this.topology) {
      return this.errorResponse(501, "NPS-SERVER-UNSUPPORTED", ErrorCodes.NWP_NODE_UNAVAILABLE,
        "topology.snapshot is not available — no topology service registered.");
    }

    try {
      const request = parseSnapshotRequest(body);
      const snapshot = await this.topology.getSnapshot(request);
      // NWP §12.2: every topology.snapshot response MUST carry the current cluster_epoch.
      const stamped = this.fence ? this.fence.stampResponse(snapshotToDict(snapshot)) : snapshotToDict(snapshot);
      const caps = { anchor_ref: TopologyWire.SNAPSHOT_ANCHOR_REF, count: 1, data: [stamped] };
      return new Response(JSON.stringify(caps), {
        status: 200,
        headers: {
          "content-type": H.MIME_CAPSULE,
          [H.HDR_NODE_TYPE.toLowerCase()]: "anchor",
          [H.HDR_SCHEMA.toLowerCase()]: TopologyWire.SNAPSHOT_ANCHOR_REF,
        },
      });
    } catch (e) {
      if (e instanceof TopologyProtocolError) {
        return this.errorResponse(topologyHttpStatus(e.npsStatus), e.npsStatus, e.nwpErrorCode, e.message);
      }
      throw e;
    }
  }

  // ── /subscribe ───────────────────────────────────────────────────────────────

  private async handleSubscribe(req: Request): Promise<Response> {
    const capCheck = this.checkTopologyCapability(req);
    if (capCheck) return capCheck;

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_QUERY_FILTER_INVALID, String(e));
    }

    const fenced = this.applyFence(req, body, false);
    if (fenced) return fenced;

    if (body["type"] !== TopologyWire.TYPE_STREAM) {
      const t = body["type"];
      return this.errorResponse(501, "NPS-SERVER-UNSUPPORTED", ErrorCodes.NWP_RESERVED_TYPE_UNSUPPORTED,
        t == null ? "Anchor /subscribe requires a reserved type per NPS-2 §12."
          : `Reserved subscribe type '${String(t)}' is not implemented by this Anchor Node.`);
    }
    if (!this.topology) {
      return this.errorResponse(501, "NPS-SERVER-UNSUPPORTED", ErrorCodes.NWP_NODE_UNAVAILABLE,
        "topology.stream is not available — no topology service registered.");
    }

    let request: AnchorStreamRequest;
    let streamId: string;
    try {
      [request, streamId] = parseStreamRequest(body);
    } catch (e) {
      if (e instanceof TopologyProtocolError) {
        return this.errorResponse(topologyHttpStatus(e.npsStatus), e.npsStatus, e.nwpErrorCode, e.message);
      }
      throw e;
    }

    const topology = this.topology;
    const encoder = new TextEncoder();
    // NWP §12.2: every topology.stream response carries the current cluster_epoch.
    const clusterEpoch = this.fence?.ownEpoch;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writeLine = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        const ack: Record<string, unknown> = { kind: "ack", stream_id: streamId, status: "subscribed",
          last_seq: 0, resumed: request.sinceVersion !== undefined };
        if (clusterEpoch !== undefined) ack["cluster_epoch"] = clusterEpoch;
        writeLine(ack);
        try {
          for await (const ev of topology.subscribe(request)) {
            writeLine(eventToEnvelope(streamId, ev));
            if (ev.kind === "resync_required") break;
          }
        } catch (e) {
          if (e instanceof TopologyProtocolError) {
            writeLine({ status: e.npsStatus, error: e.nwpErrorCode, message: e.message });
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": H.MIME_CAPSULE, [H.HDR_NODE_TYPE.toLowerCase()]: "anchor" },
    });
  }

  // ── /invoke ──────────────────────────────────────────────────────────────────

  private async handleInvoke(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    let frame: ActionFrame;
    try {
      body = (await req.json()) as Record<string, unknown>;
      frame = ActionFrame.fromDict(body);
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID, String(e));
    }

    // NPS-CR-0009 §3.2(b): `/invoke` is this Anchor's only topology-mutating path, so it is
    // gated by the leader check as well as the fence.
    const fenced = this.applyFence(req, body, true);
    if (fenced) return fenced;

    const spec = this.opt.actions[frame.actionId];
    if (!spec) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
        `Unknown action_id '${frame.actionId}'.`);
    }
    if (frame.async_ && !spec.async_) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        `action '${frame.actionId}' does not support async execution.`);
    }

    const agentNid = req.headers.get(H.HDR_AGENT) ?? undefined;
    const consumerKey = agentNid ?? "anonymous";
    const effectiveTimeout = this.clampTimeout(frame.timeoutMs ?? 0, spec);
    const budgetCgn = this.readEffectiveBudget(req);
    const cgnCostHint = spec.estimatedCgn ?? 0;

    const rate = this.limiter.tryAcquire(consumerKey, cgnCostHint);
    if (!rate.allowed) {
      const extra = rate.retryAfterSeconds ? { "retry-after": String(rate.retryAfterSeconds) } : undefined;
      return this.errorResponse(429, "NPS-LIMIT-RATE", ErrorCodes.NWP_BUDGET_EXCEEDED,
        rate.reason ?? "rate limit exceeded.", undefined, extra);
    }

    try {
      const assurance = extractIdentAssurance(req);
      const policy = this.opt.reputationPolicy;
      if (policy && (policy.enabled ?? true) && this.evaluator) {
        let decision: ReputationDecision;
        try {
          decision = await this.evaluator.evaluate(consumerKey, assurance.wire, policy);
        } catch {
          return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE,
            "reputation evaluation failed.");
        }
        const repResp = this.applyReputation(decision, policy, assurance);
        if (repResp) return repResp;
      }

      if (budgetCgn > 0 && cgnCostHint > 0 && cgnCostHint > budgetCgn) {
        return this.errorResponse(400, "NPS-CLIENT-REQUEST-TOO-LARGE", ErrorCodes.NWP_CGN_LIMIT_EXCEEDED,
          `estimated CGN ${cgnCostHint} exceeds effective budget ${budgetCgn}.`,
          { effective_budget: budgetCgn, estimated_cgn: cgnCostHint });
      }

      if (!this.handler) {
        return this.errorResponse(501, "NPS-SERVER-UNSUPPORTED", ErrorCodes.NWP_NODE_UNAVAILABLE,
          "no invoke handler registered on this Anchor Node.");
      }

      const traceId = this.opt.autoInjectTraceContext ? randomHex(16) : undefined;
      const spanId = this.opt.autoInjectTraceContext ? randomHex(8) : undefined;
      const ctx: InvokeContext = { agentNid, effectiveTimeoutMs: effectiveTimeout, budgetCgn, traceId, spanId };

      if (frame.async_) {
        const taskId = randomHex(16);
        void Promise.resolve(this.handler(frame.actionId, frame, ctx)).catch(() => undefined);
        return new Response(JSON.stringify({ task_id: taskId, status: "pending", poll_url: `${this.prefix}/invoke` }),
          { status: 202, headers: { "content-type": "application/json", [H.HDR_NODE_TYPE.toLowerCase()]: "anchor" } });
      }

      let result: unknown;
      try {
        result = await this.handler(frame.actionId, frame, ctx);
      } catch (e) {
        if (e instanceof AnchorActionError) {
          return this.errorResponse(e.httpStatus, e.npsStatus, e.errorCode, e.message, e.details);
        }
        return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE,
          "anchor task execution failed.");
      }

      const caps = {
        anchor_ref: spec.resultAnchor ?? "",
        count: result == null ? 0 : 1,
        data: result == null ? [] : [result],
      };
      const headers: Record<string, string> = {
        "content-type": H.MIME_CAPSULE,
        [H.HDR_NODE_TYPE.toLowerCase()]: "anchor",
      };
      if (spec.resultAnchor) headers[H.HDR_SCHEMA.toLowerCase()] = spec.resultAnchor;
      if (spec.estimatedCgn) headers[H.HDR_TOKENS.toLowerCase()] = String(spec.estimatedCgn);
      return new Response(JSON.stringify(caps), { status: 200, headers });
    } finally {
      this.limiter.release(consumerKey);
    }
  }

  private applyReputation(
    decision: ReputationDecision,
    policy: ReputationPolicy,
    assurance: AssuranceLevel,
  ): Response | null {
    // The reference evaluator (nwp/reputation.ts) carries the matched rule rather than separate
    // incident/severity fields; derive them from matchedRule.
    const incident = decision.matchedRule?.incident;
    const severity = decision.matchedRule?.severity;
    switch (decision.outcome) {
      case RepOutcome.Accept:
        return null;
      case RepOutcome.Ban: {
        const details = incident !== undefined
          ? { matched_incident: incident, matched_severity: severity }
          : undefined;
        return this.errorResponse(403, "NPS-AUTH-FORBIDDEN", ErrorCodes.NWP_REPUTATION_BANNED,
          incident !== undefined
            ? `Request rejected: ${incident} (${severity}) — NID temporarily banned.`
            : "Request rejected: NID temporarily banned.",
          details);
      }
      case RepOutcome.Reject:
        if (decision.errorCode === ErrorCodes.NWP_AUTH_ASSURANCE_TOO_LOW) {
          return this.errorResponse(403, "NPS-AUTH-FORBIDDEN", ErrorCodes.NWP_AUTH_ASSURANCE_TOO_LOW,
            `Assurance level too low: requires '${policy.minAssuranceLevel ?? "anonymous"}', caller declared '${assurance.wire}'.`,
            { matched_incident: null, hint: this.opt.assuranceHintUrl });
        }
        return this.errorResponse(403, "NPS-AUTH-FORBIDDEN", ErrorCodes.NWP_REPUTATION_REJECTED,
          incident !== undefined
            ? `Request rejected: ${incident} (${severity}).`
            : "Request rejected by reputation policy.",
          incident !== undefined
            ? { matched_incident: incident, matched_severity: severity }
            : undefined);
      case RepOutcome.Throttle:
        return this.errorResponse(429, "NPS-CLIENT-RATE-LIMITED", ErrorCodes.NWP_REPUTATION_THROTTLED,
          incident !== undefined
            ? `Request rate-limited: ${incident} (${severity}).`
            : "Request rate-limited by reputation policy.",
          incident !== undefined
            ? { matched_incident: incident, matched_severity: severity }
            : undefined,
          { "retry-after": "60" });
    }
  }

  // ── Gates / helpers ────────────────────────────────────────────────────────────

  /**
   * NPS-CR-0009 §3.2 — run the epoch fence (and, for topology writes, the leader check).
   * Returns an error `Response` when the request is refused, `null` when it may proceed.
   * A no-op when no {@link AnchorEpochFence} was supplied (single-Anchor deployment).
   */
  private applyFence(req: Request, body: Record<string, unknown> | undefined, isTopologyWrite: boolean): Response | null {
    if (!this.fence) return null;
    try {
      this.fence.onInboundFrame(readInboundEpoch(req, body), isTopologyWrite);
      return null;
    } catch (e) {
      if (e instanceof TopologyProtocolError) {
        return this.errorResponse(topologyHttpStatus(e.npsStatus), e.npsStatus, e.nwpErrorCode, e.message);
      }
      throw e;
    }
  }

  private checkTopologyCapability(req: Request): Response | null {
    if (!this.opt.requireTopologyCapability) return null;
    const raw = req.headers.get(H.HDR_CAPABILITIES) ?? "";
    const caps = new Set(raw.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean));
    if (caps.has("topology:read")) return null;
    return this.errorResponse(403, "NPS-AUTH-FORBIDDEN", ErrorCodes.NWP_TOPOLOGY_UNAUTHORIZED,
      "Caller must declare 'topology:read' in X-NWP-Capabilities to access topology endpoints.");
  }

  private clampTimeout(requested: number, spec: AnchorActionSpec): number {
    const specMax = spec.timeoutMsMax ?? this.opt.maxTimeoutMs;
    const hardMax = Math.min(specMax, this.opt.maxTimeoutMs);
    if (requested <= 0) return spec.timeoutMsDefault ?? this.opt.defaultTimeoutMs;
    return Math.min(requested, hardMax);
  }

  private readEffectiveBudget(req: Request): number {
    const raw = req.headers.get(H.HDR_BUDGET);
    let agentBudget = this.opt.defaultTokenBudget;
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed)) agentBudget = parsed;
    }
    const cgnLimit = this.opt.cgnLimit;
    if (cgnLimit === 0) return agentBudget;
    if (agentBudget === 0) return cgnLimit;
    return Math.min(cgnLimit, agentBudget);
  }

  private errorResponse(
    httpStatus: number,
    npsStatus: string,
    errorCode: string,
    message: string,
    details?: unknown,
    extraHeaders?: Record<string, string>,
  ): Response {
    const env: Record<string, unknown> = { status: npsStatus, error: errorCode, message };
    if (details !== undefined) env["details"] = details;
    return new Response(JSON.stringify(env), {
      status: httpStatus,
      headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
    });
  }

  // ── Manifest ───────────────────────────────────────────────────────────────────

  private actionsDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [actionId, spec] of Object.entries(this.opt.actions)) {
      const entry: Record<string, unknown> = { action_id: actionId, async: spec.async_ ?? false };
      if (spec.description !== undefined) entry["description"] = spec.description;
      if (spec.paramsAnchor !== undefined) entry["params_anchor"] = spec.paramsAnchor;
      if (spec.resultAnchor !== undefined) entry["result_anchor"] = spec.resultAnchor;
      if (spec.estimatedCgn !== undefined) entry["cgn_est"] = spec.estimatedCgn;
      if (spec.timeoutMsDefault !== undefined) entry["timeout_ms_default"] = spec.timeoutMsDefault;
      if (spec.timeoutMsMax !== undefined) entry["timeout_ms_max"] = spec.timeoutMsMax;
      if (spec.requiredCapability !== undefined) entry["required_capability"] = spec.requiredCapability;
      out[actionId] = entry;
    }
    return out;
  }

  private buildManifest(): Record<string, unknown> {
    const o = this.opt;
    const base = this.prefix;
    const m: Record<string, unknown> = { nwp: "0.4", node_id: o.nodeId, node_type: "anchor" };
    if (o.displayName !== undefined) m["display_name"] = o.displayName;
    m["wire_formats"] = ["ncp-capsule", "json"];
    m["preferred_format"] = "json";
    m["capabilities"] = {
      query: false, stream: false, subscribe: false, vector_search: false,
      token_budget_hint: true, ext_frame: false,
    };
    const auth: Record<string, unknown> = {
      required: o.requireAuth,
      identity_type: o.requireAuth ? "nip-cert" : "none",
    };
    if (o.requiredCapabilities !== undefined) auth["required_capabilities"] = o.requiredCapabilities;
    m["auth"] = auth;
    m["endpoints"] = { invoke: `${base}/invoke`, schema: `${base}/.schema` };
    if (o.cgnLimit > 0) m["token_budget"] = { cgn_limit: o.cgnLimit, profile: "cgn.v1" };
    if (o.rateLimits !== undefined) m["rate_limits"] = o.rateLimits;
    if (o.reputationPolicy && (o.reputationPolicy.enabled ?? true)) {
      m["reputation_policy"] = reputationPolicyToWire(o.reputationPolicy);
    }
    if (o.trustAnchors && o.trustAnchors.length > 0) m["trust_anchors"] = o.trustAnchors;
    m["actions"] = Object.values(this.actionsDict());
    return m;
  }
}

// ── Request parsing ────────────────────────────────────────────────────────────

function parseSnapshotRequest(body: Record<string, unknown>): AnchorSnapshotRequest {
  const topo = body["topology"];
  if (typeof topo !== "object" || topo === null) {
    throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_UNSUPPORTED_SCOPE, "NPS-CLIENT-BAD-PARAM",
      "topology.snapshot requires a 'topology' object per NPS-2 §12.1.");
  }
  const t = topo as Record<string, unknown>;
  const scope = parseScope(t);
  const include = parseInclude(t);
  const depth = parseDepth(t);
  const targetNid = typeof t["target_nid"] === "string" ? (t["target_nid"] as string) : undefined;
  if (scope === TopologyWire.SCOPE_MEMBER && !targetNid) {
    throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_UNSUPPORTED_SCOPE, "NPS-CLIENT-BAD-PARAM",
      'topology.target_nid is required when topology.scope = "member".');
  }
  return { scope, include, depth, targetNid };
}

function parseStreamRequest(body: Record<string, unknown>): [AnchorStreamRequest, string] {
  const topo = body["topology"];
  if (typeof topo !== "object" || topo === null) {
    throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_UNSUPPORTED_SCOPE, "NPS-CLIENT-BAD-PARAM",
      "topology.stream requires a 'topology' object per NPS-2 §12.2.");
  }
  const t = topo as Record<string, unknown>;
  const scope = parseScope(t);
  let filter: TopologyFilter | undefined;
  const f = t["filter"];
  if (typeof f === "object" && f !== null) {
    validateFilterKeys(f as Record<string, unknown>);
    const fo = f as Record<string, unknown>;
    filter = {
      tags_any: fo["tags_any"] as string[] | undefined,
      tags_all: fo["tags_all"] as string[] | undefined,
      node_roles: fo["node_roles"] as string[] | undefined,
    };
  }
  let since = t["since_version"];
  if (since === undefined) since = body["resume_from_seq"];
  const sinceVersion = typeof since === "number" ? since : undefined;
  let streamId = body["stream_id"];
  if (typeof streamId !== "string" || !streamId) streamId = randomHex(16);
  return [{ scope, filter, sinceVersion }, streamId as string];
}

function parseScope(t: Record<string, unknown>): string {
  const s = t["scope"];
  if (s === undefined) return TopologyWire.SCOPE_CLUSTER;
  if (s === TopologyWire.SCOPE_CLUSTER || s === TopologyWire.SCOPE_MEMBER) return s;
  throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_UNSUPPORTED_SCOPE, "NPS-CLIENT-BAD-PARAM",
    `unknown topology.scope '${String(s)}'.`);
}

function parseInclude(t: Record<string, unknown>): Set<string> {
  const inc = t["include"];
  if (!Array.isArray(inc)) return new Set(["members"]);
  const known = new Set(["members", "capabilities", "tags", "metrics"]);
  const flags = new Set((inc as unknown[]).filter((v): v is string => typeof v === "string" && known.has(v)));
  return flags.size ? flags : new Set(["members"]);
}

function parseDepth(t: Record<string, unknown>): number {
  const d = t["depth"];
  if (typeof d === "number" && d > 0) return d;
  return 1;
}

function validateFilterKeys(filterObj: Record<string, unknown>): void {
  for (const key of Object.keys(filterObj)) {
    if (key === "tags_any" || key === "tags_all" || key === "node_roles") continue;
    if (key === "node_kind") {
      throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_FILTER_UNSUPPORTED, "NPS-CLIENT-BAD-PARAM",
        "topology.filter.node_kind expired after alpha.5; use node_roles.");
    }
    throw new TopologyProtocolError(ErrorCodes.NWP_TOPOLOGY_FILTER_UNSUPPORTED, "NPS-CLIENT-BAD-PARAM",
      `topology.filter key '${key}' is not recognized.`);
  }
}

function extractIdentAssurance(req: Request): AssuranceLevel {
  const raw = req.headers.get(H.HDR_IDENT);
  if (!raw) return AssuranceLevel.ANONYMOUS;
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const lvl = doc["assurance_level"];
    if (typeof lvl === "string") return AssuranceLevel.fromWire(lvl);
  } catch {
    /* malformed — fall through */
  }
  return AssuranceLevel.ANONYMOUS;
}
