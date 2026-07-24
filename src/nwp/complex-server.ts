// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS NWP — Complex Node server (Web-standard Fetch handler, zero deps).
 *
 * Faithful port of the .NET `ComplexNodeMiddleware` wire contract (NPS-2 §2.1, §11).
 * Same shape as {@link AnchorNodeApp}: {@link ComplexNodeApp.fetch} takes a `Request`
 * and returns a `Response`. Sub-paths under `pathPrefix`: `/.nwm`, `/.schema`,
 * `/actions`, `/query`, `/invoke`.
 *
 * On `/query` the server asks the provider for local rows, then — if the request
 * carries `X-NWP-Depth > 0` and at least one child ref is declared — fetches each
 * child's `/query` concurrently and attaches the child capsules under `graph`.
 * Cycle detection uses the `X-NWP-Trace` header (comma-separated node_ids); depth is
 * clamped to {@link COMPLEX_ABSOLUTE_MAX_DEPTH} (5).
 */

import { createHash } from "node:crypto";
import { ActionFrame, QueryFrame } from "./frames.js";
import type { FrameSchema } from "../ncp/frames/anchor-frame.js";
import * as ErrorCodes from "./nwp-error-codes.js";
import * as H from "./http-headers.js";
import { validateChildUrl } from "./callback-validator.js";
import type {
  ActionContext, ActionExecutionResult, ActionSpec, IActionNodeProvider,
} from "./action-server.js";
import { ActionExecutionError, SYSTEM_TASK_CANCEL, SYSTEM_TASK_STATUS } from "./action-server.js";
import type { MemoryNodeSchema, MemoryNodeQueryResult, IMemoryNodeProvider } from "./memory-server.js";

// ── Constants ───────────────────────────────────────────────────────────────────

/** Header carrying the visited-nodes trace for cycle detection. */
export const COMPLEX_TRACE_HEADER = "X-NWP-Trace";
/** Absolute traversal ceiling per NPS-2 §11 (X-NWP-Depth upper bound). */
export const COMPLEX_ABSOLUTE_MAX_DEPTH = 5;

// ── Graph ref ───────────────────────────────────────────────────────────────────

/** Child node reference declared in the NWM (NPS-2 §11). */
export interface ComplexGraphRef {
  /** Semantic relationship label, e.g. "user", "payment". */
  rel: string;
  /** Absolute child URL, e.g. https://api.myapp.com/users. */
  nodeUrl: string;
}

// ── Provider interface ──────────────────────────────────────────────────────────

/** Local behaviour of a Complex Node — mixes Memory + Action surfaces. */
export interface IComplexNodeProvider {
  query(frame: QueryFrame, options: ComplexNodeOptions, signal?: AbortSignal): Promise<MemoryNodeQueryResult>;
  execute(frame: ActionFrame, context: ActionContext, signal?: AbortSignal): Promise<ActionExecutionResult>;
}

/** Provider for Complex Nodes that only aggregate children (no local data/actions). */
export class NullComplexNodeProvider implements IComplexNodeProvider {
  async query(): Promise<MemoryNodeQueryResult> {
    return { rows: [] };
  }
  async execute(): Promise<ActionExecutionResult> {
    throw new Error("NullComplexNodeProvider does not handle actions.");
  }
}

// ── Options (NPS-2 §2.1, §11) ───────────────────────────────────────────────────

export interface ComplexNodeOptions {
  nodeId: string;
  displayName?: string;
  pathPrefix: string;
  /** Optional local row schema exposing /query + /.schema (Memory-Node-like). */
  schema?: MemoryNodeSchema;
  /** Action registry (may be empty). Reserved system ids MUST NOT be registered. */
  actions?: Record<string, ActionSpec>;
  /** Child node references declared in the NWM (NPS-2 §11). */
  graph?: ComplexGraphRef[];
  /** Max traversal depth advertised/honoured. Clamped to absolute cap. Default 2. */
  graphMaxDepth?: number;
  /** URL prefixes that child addresses MUST start with. Empty = no allowlist. */
  allowedChildUrlPrefixes?: string[];
  /** Reject child hosts resolving to loopback/private/link-local. Default true. */
  rejectPrivateChildUrls?: boolean;
  /** Dev escape hatch: accept http:// child URLs. Default false. */
  allowHttpChildUrls?: boolean;
  requireAuth?: boolean;
  defaultLimit?: number;
  maxLimit?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  /** Timeout (ms) for outbound child-node fetches during graph expansion. Default 10000. */
  childFetchTimeoutMs?: number;
}

// ── The Fetch app ───────────────────────────────────────────────────────────────

export interface ComplexNodeAppDeps {
  /** Injectable fetch used for child-node graph expansion. Defaults to globalThis.fetch. */
  childFetch?: typeof fetch;
}

interface ChildFetchResult {
  rel: string;
  node: string;
  data?: unknown;
  error?: { code: string; message: string };
}

export class ComplexNodeApp {
  private readonly opt: Required<Pick<ComplexNodeOptions,
    "requireAuth" | "graphMaxDepth" | "rejectPrivateChildUrls" | "allowHttpChildUrls"
    | "defaultLimit" | "maxLimit" | "defaultTimeoutMs" | "maxTimeoutMs" | "childFetchTimeoutMs">>
    & ComplexNodeOptions;
  private readonly prefix: string;
  private readonly provider: IComplexNodeProvider;
  private readonly graph: ComplexGraphRef[];
  private readonly actions: Record<string, ActionSpec>;
  private readonly childFetch: typeof fetch;
  private readonly nwmJson: string;
  private readonly schemaJson: string;
  private readonly actionsJson: string;
  private readonly anchorId: string;

  constructor(provider: IComplexNodeProvider, options: ComplexNodeOptions, deps: ComplexNodeAppDeps = {}) {
    const actions = options.actions ?? {};
    if (actions[SYSTEM_TASK_STATUS] || actions[SYSTEM_TASK_CANCEL]) {
      throw new Error(
        `Reserved action ids '${SYSTEM_TASK_STATUS}' / '${SYSTEM_TASK_CANCEL}' MUST NOT be registered on a Complex Node.`);
    }
    const graphMaxDepth = options.graphMaxDepth ?? 2;
    if (graphMaxDepth > COMPLEX_ABSOLUTE_MAX_DEPTH) {
      throw new Error(`graphMaxDepth ${graphMaxDepth} exceeds NPS-2 §11 absolute cap ${COMPLEX_ABSOLUTE_MAX_DEPTH}.`);
    }
    this.opt = {
      requireAuth: false,
      graphMaxDepth,
      rejectPrivateChildUrls: true,
      allowHttpChildUrls: false,
      defaultLimit: 20,
      maxLimit: 1000,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 300_000,
      childFetchTimeoutMs: 10_000,
      ...options,
    };
    this.prefix = options.pathPrefix.replace(/\/+$/, "");
    this.provider = provider;
    this.graph = options.graph ?? [];
    this.actions = actions;
    this.childFetch = deps.childFetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

    const built = this.buildStaticPayloads();
    this.anchorId = built.anchorId;
    this.schemaJson = built.schemaJson;
    this.actionsJson = built.actionsJson;
    this.nwmJson = built.nwmJson;
  }

  /** WHATWG Fetch handler. */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.toLowerCase().startsWith(this.prefix.toLowerCase())) return new Response(null, { status: 404 });
    const sub = path.slice(this.prefix.length);

    if (this.opt.requireAuth && !req.headers.get(H.HDR_AGENT)) {
      return this.errorResponse(401, "NPS-CLIENT-UNAUTHORIZED", ErrorCodes.NWP_AUTH_NID_SCOPE_VIOLATION,
        "X-NWP-Agent header is required.");
    }

    switch (sub) {
      case "/.nwm":
      case "/.nwm/":
        return new Response(this.nwmJson, {
          status: 200,
          headers: { "content-type": H.MIME_MANIFEST, [H.HDR_NODE_TYPE.toLowerCase()]: "complex" },
        });
      case "/.schema":
      case "/.schema/": {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (this.anchorId.length > 0) headers[H.HDR_SCHEMA.toLowerCase()] = this.anchorId;
        return new Response(this.schemaJson, { status: 200, headers });
      }
      case "/actions":
      case "/actions/":
        return new Response(this.actionsJson, { status: 200, headers: { "content-type": "application/json" } });
      case "/query":
      case "/query/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleQuery(req);
      case "/invoke":
      case "/invoke/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleInvoke(req);
      default:
        return new Response(null, { status: 404 });
    }
  };

  // ── /query ───────────────────────────────────────────────────────────────────

  private async handleQuery(req: Request): Promise<Response> {
    let frame: QueryFrame;
    try {
      frame = QueryFrame.fromDict((await req.json()) as Record<string, unknown>);
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_QUERY_FILTER_INVALID, String(e));
    }

    // Depth parsing (header absent => 0 = local only).
    const depthRaw = req.headers.get(H.HDR_DEPTH);
    let requestedDepth = 0;
    if (depthRaw !== null) {
      const parsed = Number(depthRaw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_DEPTH_EXCEEDED,
          `X-NWP-Depth '${depthRaw}' is not a non-negative integer.`);
      }
      if (parsed > this.opt.graphMaxDepth) {
        return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_DEPTH_EXCEEDED,
          `X-NWP-Depth ${parsed} exceeds node max_depth ${this.opt.graphMaxDepth}.`);
      }
      if (parsed > COMPLEX_ABSOLUTE_MAX_DEPTH) {
        return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_DEPTH_EXCEEDED,
          `X-NWP-Depth ${parsed} exceeds NPS-2 §11 absolute cap ${COMPLEX_ABSOLUTE_MAX_DEPTH}.`);
      }
      requestedDepth = parsed;
    }

    // Cycle detection.
    const trace = parseTrace(req.headers.get(COMPLEX_TRACE_HEADER));
    if (trace.includes(this.opt.nodeId)) {
      return this.errorResponse(422, "NPS-CLIENT-UNPROCESSABLE", ErrorCodes.NWP_GRAPH_CYCLE,
        `graph cycle detected at '${this.opt.nodeId}'.`);
    }

    let local: MemoryNodeQueryResult;
    try {
      local = await this.provider.query(frame, this.opt);
    } catch {
      return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE, "local query failed.");
    }

    let graphElement: unknown[] | undefined;
    if (requestedDepth > 0 && this.graph.length > 0) {
      const nextTrace = [...trace, this.opt.nodeId];
      const childDepth = requestedDepth - 1;
      graphElement = await Promise.all(
        this.graph.map((ref) => this.fetchChild(ref, frame, childDepth, nextTrace, req)),
      );
    }

    const caps: Record<string, unknown> = {
      anchor_ref: this.anchorId.length > 0 ? this.anchorId : null,
      count: local.rows.length,
      data: local.rows,
    };
    if (local.nextCursor !== undefined) caps["next_cursor"] = local.nextCursor;
    if (graphElement !== undefined) caps["graph"] = graphElement;

    const headers: Record<string, string> = {
      "content-type": H.MIME_CAPSULE,
      [H.HDR_NODE_TYPE.toLowerCase()]: "complex",
    };
    if (this.anchorId.length > 0) headers[H.HDR_SCHEMA.toLowerCase()] = this.anchorId;
    return new Response(JSON.stringify(caps), { status: 200, headers });
  }

  private async fetchChild(
    ref: ComplexGraphRef,
    frame: QueryFrame,
    childDepth: number,
    nextTrace: string[],
    parentReq: Request,
  ): Promise<ChildFetchResult> {
    const ssrfError = validateChildUrl(
      ref.nodeUrl, this.opt.allowedChildUrlPrefixes ?? [],
      this.opt.rejectPrivateChildUrls, this.opt.allowHttpChildUrls);
    if (ssrfError !== null) {
      return { rel: ref.rel, node: ref.nodeUrl, error: { code: ErrorCodes.NWP_AUTH_NID_SCOPE_VIOLATION, message: ssrfError } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opt.childFetchTimeoutMs);
    const headers = new Headers({ "content-type": H.MIME_FRAME });
    headers.set(H.HDR_DEPTH, String(childDepth));
    headers.set(COMPLEX_TRACE_HEADER, nextTrace.join(","));
    const agent = parentReq.headers.get(H.HDR_AGENT);
    if (agent) headers.set(H.HDR_AGENT, agent);
    const budget = parentReq.headers.get(H.HDR_BUDGET);
    if (budget) headers.set(H.HDR_BUDGET, budget);

    try {
      const resp = await this.childFetch(ref.nodeUrl.replace(/\/+$/, "") + "/query", {
        method: "POST",
        headers,
        body: JSON.stringify(frame.toDict()),
        signal: controller.signal,
      });
      const body = await resp.text();
      if (!resp.ok) {
        return { rel: ref.rel, node: ref.nodeUrl,
          error: { code: ErrorCodes.NWP_NODE_UNAVAILABLE, message: `child '${ref.rel}' returned ${resp.status}: ${truncate(body)}` } };
      }
      try {
        return { rel: ref.rel, node: ref.nodeUrl, data: JSON.parse(body) };
      } catch (jx) {
        return { rel: ref.rel, node: ref.nodeUrl,
          error: { code: ErrorCodes.NWP_NODE_UNAVAILABLE, message: `child '${ref.rel}' returned non-JSON body: ${String(jx)}` } };
      }
    } catch (e) {
      const msg = controller.signal.aborted ? `child '${ref.rel}' fetch timed out.`
        : (e instanceof Error ? e.message : String(e));
      return { rel: ref.rel, node: ref.nodeUrl, error: { code: ErrorCodes.NWP_NODE_UNAVAILABLE, message: msg } };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── /invoke ──────────────────────────────────────────────────────────────────

  private async handleInvoke(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID, String(e));
    }
    const frame = ActionFrame.fromDict(body);
    const priority = (body["priority"] as string | null) ?? undefined;
    const requestId = (body["request_id"] as string | null) ?? null;

    const spec = this.actions[frame.actionId];
    if (!spec) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
        `Unknown action_id '${frame.actionId}'.`);
    }

    // Complex Node has no async task machinery.
    if (frame.async_) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        "Complex Node does not support async actions; invoke a downstream Action Node instead.");
    }

    if (priority !== undefined && priority !== "low" && priority !== "normal" && priority !== "high") {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        `priority '${priority}' is invalid (allowed: low/normal/high).`);
    }

    const timeoutMs = this.clampTimeout(frame.timeoutMs ?? 0, spec);
    const agentNid = req.headers.get(H.HDR_AGENT);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: ActionExecutionResult;
    try {
      result = await this.provider.execute(frame, {
        agentNid, requestId, taskId: null, spec, timeoutMs, priority: priority ?? "normal",
      }, controller.signal);
    } catch (e) {
      if (e instanceof ActionExecutionError) {
        return this.errorResponse(e.httpStatus, e.npsStatus, e.errorCode, e.message);
      }
      if (controller.signal.aborted) {
        return this.errorResponse(504, "NPS-SERVER-TIMEOUT", ErrorCodes.NWP_NODE_UNAVAILABLE, "action execution timed out.");
      }
      return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE, "action execution failed.");
    } finally {
      clearTimeout(timer);
    }

    const anchorRef = result.anchorRef ?? spec.resultAnchor ?? "";
    const data = result.result === null || result.result === undefined ? [] : [result.result];
    const tokenEst = result.tokenEst ?? 0;
    const caps: Record<string, unknown> = { anchor_ref: anchorRef, count: data.length, data };
    if (tokenEst > 0) caps["token_est"] = tokenEst;
    const headers: Record<string, string> = {
      "content-type": H.MIME_CAPSULE,
      [H.HDR_NODE_TYPE.toLowerCase()]: "complex",
    };
    if (anchorRef) headers[H.HDR_SCHEMA.toLowerCase()] = anchorRef;
    if (tokenEst > 0) headers[H.HDR_TOKENS.toLowerCase()] = String(tokenEst);
    if (requestId !== null) headers[H.HDR_REQUEST_ID.toLowerCase()] = requestId;
    return new Response(JSON.stringify(caps), { status: 200, headers });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private clampTimeout(requested: number, spec: ActionSpec): number {
    const specMax = spec.timeoutMsMax ?? this.opt.maxTimeoutMs;
    const hardMax = Math.min(specMax, this.opt.maxTimeoutMs);
    if (requested <= 0) return spec.timeoutMsDefault ?? this.opt.defaultTimeoutMs;
    return requested > hardMax ? hardMax : requested;
  }

  private errorResponse(httpStatus: number, npsStatus: string, errorCode: string, message: string): Response {
    return new Response(JSON.stringify({ status: npsStatus, error: errorCode, message }), {
      status: httpStatus,
      headers: { "content-type": "application/json" },
    });
  }

  private buildStaticPayloads(): { nwmJson: string; schemaJson: string; actionsJson: string; anchorId: string } {
    const base = this.prefix;
    let schemaJson = "{}";
    let anchorId = "";
    let schemaAnchors: Record<string, string> | null = null;

    if (this.opt.schema) {
      const frameSchema: FrameSchema = {
        fields: this.opt.schema.fields.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable ?? true })),
      };
      schemaJson = JSON.stringify(frameSchema);
      anchorId = "sha256:" + createHash("sha256").update(schemaJson).digest("hex");
      schemaAnchors = { default: anchorId };
    }

    const hasActions = Object.keys(this.actions).length > 0;
    const endpoints: Record<string, unknown> = { query: `${base}/query`, schema: `${base}/.schema` };
    if (hasActions) endpoints["invoke"] = `${base}/invoke`;

    const graphNwm = this.graph.length > 0
      ? { refs: this.graph.map((r) => ({ rel: r.rel, node_url: r.nodeUrl })), max_depth: this.opt.graphMaxDepth }
      : null;

    const m: Record<string, unknown> = {
      nwp: "0.4",
      node_id: this.opt.nodeId,
      node_type: "complex",
      display_name: this.opt.displayName ?? null,
      wire_formats: ["ncp-capsule", "json"],
      preferred_format: "json",
      schema_anchors: schemaAnchors,
      capabilities: {
        query: this.opt.schema !== undefined || this.graph.length > 0,
        stream: false,
        token_budget_hint: true,
      },
      auth: { required: this.opt.requireAuth, identity_type: this.opt.requireAuth ? "nip-cert" : "none" },
      endpoints,
      graph: graphNwm,
    };

    const actionsJson = JSON.stringify({ actions: this.actionsDict() });
    return { nwmJson: JSON.stringify(m), schemaJson, actionsJson, anchorId };
  }

  private actionsDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [actionId, spec] of Object.entries(this.actions)) {
      const entry: Record<string, unknown> = { async: spec.async ?? false };
      if (spec.description !== undefined) entry["description"] = spec.description;
      if (spec.paramsAnchor !== undefined) entry["params_anchor"] = spec.paramsAnchor;
      if (spec.resultAnchor !== undefined) entry["result_anchor"] = spec.resultAnchor;
      if (spec.timeoutMsDefault !== undefined) entry["timeout_ms_default"] = spec.timeoutMsDefault;
      if (spec.timeoutMsMax !== undefined) entry["timeout_ms_max"] = spec.timeoutMsMax;
      if (spec.requiredCapability !== undefined) entry["required_capability"] = spec.requiredCapability;
      out[actionId] = entry;
    }
    return out;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseTrace(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function truncate(s: string): string {
  return s.length <= 256 ? s : s.slice(0, 256) + "…";
}

// Type re-exports referenced by consumers.
export type { MemoryNodeSchema, MemoryNodeQueryResult, IMemoryNodeProvider };
