// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS NWP — Action Node server (Web-standard Fetch handler, zero deps).
 *
 * Faithful port of the .NET `ActionNodeMiddleware` wire contract (NPS-2 §3.2, §7).
 * Built in the same shape as {@link AnchorNodeApp} in `anchor-server.ts`:
 * {@link ActionNodeApp.fetch} takes a standard `Request` and returns a `Response`,
 * so it mounts on Node (≥18), Deno, Bun, Cloudflare Workers, or any WHATWG-fetch runtime.
 *
 * Sub-paths served under `pathPrefix`: `/.nwm`, `/.schema`, `/actions`, `/invoke`.
 * Reserved actions `system.task.status` and `system.task.cancel` are handled by the
 * server itself and MUST NOT be registered in {@link ActionNodeOptions.actions}.
 */

import { createHash, randomUUID } from "node:crypto";
import { ActionFrame } from "./frames.js";
import * as ErrorCodes from "./nwp-error-codes.js";
import * as H from "./http-headers.js";
import { validateCallbackUrl } from "./callback-validator.js";
import {
  type IActionTaskStore,
  type IIdempotencyCache,
  InMemoryActionTaskStore,
  InMemoryIdempotencyCache,
} from "./action-task-store.js";

// ── Action spec (NWM action registry entry, NPS-2 §4.6) ─────────────────────────

export interface ActionSpec {
  /** Human-readable description of the operation. */
  description?: string;
  /** anchor_id of the parameter schema. */
  paramsAnchor?: string;
  /** anchor_id of the result schema (used as CapsFrame.anchor_ref on success). */
  resultAnchor?: string;
  /** Whether this action supports asynchronous execution. */
  async?: boolean;
  /** Whether the action is idempotent (clients may safely retry). */
  idempotent?: boolean;
  /** Default timeout in ms when ActionFrame.timeout_ms is absent. */
  timeoutMsDefault?: number;
  /** Maximum timeout this action honours; requests above are clamped. */
  timeoutMsMax?: number;
  /** NIP capability required to invoke this action. */
  requiredCapability?: string;
}

// ── Options (NPS-2 §2.1, §7) ────────────────────────────────────────────────────

export interface ActionNodeOptions {
  /** Node NID, e.g. `urn:nps:node:api.example.com:orders`. */
  nodeId: string;
  /** Human-readable name shown in the NWM manifest. */
  displayName?: string;
  /** Action registry. Keys are `{domain}.{verb}` ids (NPS-2 §4.6). */
  actions: Record<string, ActionSpec>;
  /** HTTP path prefix where the node listens, e.g. `"/orders"`. */
  pathPrefix: string;
  /** When true, requests without X-NWP-Agent are rejected with 401. Default false. */
  requireAuth?: boolean;
  /** Default timeout when neither spec nor frame set one. Default 5000 ms. */
  defaultTimeoutMs?: number;
  /** Hard cap per NPS-2 §7.1; requests above are clamped. Default 300000 ms. */
  maxTimeoutMs?: number;
  /** TTL (ms) for idempotency cache entries. Default 24h. */
  idempotencyTtlMs?: number;
  /** Retention (ms) for terminal-state tasks queryable via system.task.status. Default 1h. */
  taskRetentionMs?: number;
  /** When true, reject callback_url resolving to loopback/private ranges. Default true. */
  rejectPrivateCallbackUrls?: boolean;
  /** Default token budget when X-NWP-Budget header is absent. 0 = unlimited. */
  defaultTokenBudget?: number;
}

// ── Provider interface ──────────────────────────────────────────────────────────

/** Result of a single action execution. */
export interface ActionExecutionResult {
  /** Action output; serialised into CapsFrame.data (single element). null → empty data. */
  result?: unknown;
  /** Optional anchor_id for the response schema; overrides ActionSpec.resultAnchor. */
  anchorRef?: string;
  /** Approximate token count of the serialised result. 0 when unknown. */
  tokenEst?: number;
}

/** Execution context passed to the provider. */
export interface ActionContext {
  /** NID of the calling agent from X-NWP-Agent, or null. */
  agentNid: string | null;
  /** request_id echoed from the ActionFrame, or null. */
  requestId: string | null;
  /** Task id when executing asynchronously; null for sync calls. */
  taskId: string | null;
  /** Matching NWM entry for the action_id. */
  spec: ActionSpec;
  /** Effective timeout after clamping (ms). */
  timeoutMs: number;
  /** Priority hint, or "normal". */
  priority: string;
}

/**
 * Implement this to expose a set of actions. All action_id values declared in
 * {@link ActionNodeOptions.actions} MUST be handled.
 */
export interface IActionNodeProvider {
  execute(frame: ActionFrame, context: ActionContext, signal?: AbortSignal): Promise<ActionExecutionResult>;
}

/** Error a provider may throw to control the wire status. */
export class ActionExecutionError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly npsStatus: string,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionExecutionError";
  }
}

// ── Reserved action ids (NPS-2 §7.3) ────────────────────────────────────────────

export const SYSTEM_TASK_STATUS = "system.task.status";
export const SYSTEM_TASK_CANCEL = "system.task.cancel";

// ── The Fetch app ───────────────────────────────────────────────────────────────

export interface ActionNodeAppDeps {
  taskStore?: IActionTaskStore;
  idempotency?: IIdempotencyCache;
  /** Clock override, primarily for tests. Returns epoch millis. */
  clock?: () => number;
}

export class ActionNodeApp {
  private readonly opt: Required<Pick<ActionNodeOptions,
    "requireAuth" | "defaultTimeoutMs" | "maxTimeoutMs" | "idempotencyTtlMs"
    | "taskRetentionMs" | "rejectPrivateCallbackUrls" | "defaultTokenBudget">> & ActionNodeOptions;
  private readonly prefix: string;
  private readonly provider: IActionNodeProvider;
  private readonly taskStore: IActionTaskStore;
  private readonly idempotency: IIdempotencyCache;
  private readonly clock: () => number;
  private readonly nwmJson: string;
  private readonly actionsJson: string;

  constructor(provider: IActionNodeProvider, options: ActionNodeOptions, deps: ActionNodeAppDeps = {}) {
    if (options.actions[SYSTEM_TASK_STATUS] || options.actions[SYSTEM_TASK_CANCEL]) {
      throw new Error(
        `Reserved action ids '${SYSTEM_TASK_STATUS}' / '${SYSTEM_TASK_CANCEL}' are provided by the ` +
        "server and MUST NOT be registered in ActionNodeOptions.actions.");
    }
    this.opt = {
      requireAuth: false,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 300_000,
      idempotencyTtlMs: 24 * 60 * 60 * 1_000,
      taskRetentionMs: 60 * 60 * 1_000,
      rejectPrivateCallbackUrls: true,
      defaultTokenBudget: 0,
      ...options,
    };
    this.prefix = options.pathPrefix.replace(/\/+$/, "");
    this.provider = provider;
    this.clock = deps.clock ?? (() => Date.now());
    this.taskStore = deps.taskStore ?? new InMemoryActionTaskStore(this.clock);
    this.idempotency = deps.idempotency ?? new InMemoryIdempotencyCache(this.clock);
    this.nwmJson = JSON.stringify(this.buildManifest());
    this.actionsJson = JSON.stringify({ actions: this.actionsDict() });
  }

  /** WHATWG Fetch handler. */
  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.toLowerCase().startsWith(this.prefix.toLowerCase())) {
      return this.notFound();
    }
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
          headers: { "content-type": H.MIME_MANIFEST, [H.HDR_NODE_TYPE.toLowerCase()]: "action" },
        });
      case "/.schema":
      case "/.schema/":
      case "/actions":
      case "/actions/":
        return new Response(this.actionsJson, { status: 200, headers: { "content-type": "application/json" } });
      case "/invoke":
      case "/invoke/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleInvoke(req);
      default:
        return this.notFound();
    }
  };

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
    const callbackUrl = (body["callback_url"] as string | null) ?? undefined;
    const requestId = (body["request_id"] as string | null) ?? null;

    // Reserved actions handled by the server itself.
    if (frame.actionId === SYSTEM_TASK_STATUS) return this.handleSystemTaskStatus(frame, requestId);
    if (frame.actionId === SYSTEM_TASK_CANCEL) return this.handleSystemTaskCancel(frame, requestId);

    const spec = this.opt.actions[frame.actionId];
    if (!spec) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_ACTION_NOT_FOUND,
        `Unknown action_id '${frame.actionId}'.`);
    }

    // Priority validation.
    if (priority !== undefined && priority !== "low" && priority !== "normal" && priority !== "high") {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        `priority '${priority}' is invalid (allowed: low/normal/high).`);
    }

    // Async-capable check.
    if (frame.async_ && !spec.async) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        `action '${frame.actionId}' does not support async execution.`);
    }

    const effectiveTimeout = this.clampTimeout(frame.timeoutMs ?? 0, spec);

    // Callback URL SSRF guard (only if provided).
    if (callbackUrl !== undefined) {
      const err = validateCallbackUrl(callbackUrl, this.opt.rejectPrivateCallbackUrls);
      if (err !== null) {
        return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID, err);
      }
    }

    // Idempotency check (sync + async). §7.1
    const paramsHash = hashParams(frame.params);
    if (frame.idempotencyKey) {
      const cached = this.idempotency.get(frame.actionId, frame.idempotencyKey);
      if (cached) {
        if (cached.paramsHash !== paramsHash) {
          return this.errorResponse(409, "NPS-CLIENT-CONFLICT", ErrorCodes.NWP_ACTION_IDEMPOTENCY_CONFLICT,
            "idempotency_key reuse with different params.");
        }
        if (cached.taskId) {
          const status = this.taskStore.get(cached.taskId)?.status ?? "pending";
          return this.asyncResponse(cached.taskId, status, requestId, undefined);
        }
        return this.capsResponse(cached.result ?? null, cached.anchorRef, requestId);
      }
    }

    const agentNid = req.headers.get(H.HDR_AGENT);
    const effPriority = priority ?? "normal";

    if (frame.async_) {
      const taskId = randomUUID().replace(/-/g, "");
      this.taskStore.create(taskId, frame.actionId, requestId, agentNid);

      if (frame.idempotencyKey) {
        this.idempotency.tryStore(frame.actionId, frame.idempotencyKey, {
          actionId: frame.actionId,
          paramsHash,
          taskId,
          expiresAt: this.clock() + this.opt.idempotencyTtlMs,
        });
      }

      const runCtx: ActionContext = {
        agentNid, requestId, taskId, spec, timeoutMs: effectiveTimeout, priority: effPriority,
      };
      // Fire-and-forget; lifetime tied to the task, not the request.
      void this.runAsyncTask(frame, runCtx, effectiveTimeout);

      return this.asyncResponse(taskId, "pending", requestId, spec.timeoutMsDefault);
    }

    // Synchronous path.
    const syncCtx: ActionContext = {
      agentNid, requestId, taskId: null, spec, timeoutMs: effectiveTimeout, priority: effPriority,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
    let result: ActionExecutionResult;
    try {
      result = await this.provider.execute(frame, syncCtx, controller.signal);
    } catch (e) {
      if (e instanceof ActionExecutionError) {
        return this.errorResponse(e.httpStatus, e.npsStatus, e.errorCode, e.message);
      }
      if (controller.signal.aborted) {
        return this.errorResponse(504, "NPS-SERVER-TIMEOUT", ErrorCodes.NWP_NODE_UNAVAILABLE,
          "action execution timed out.");
      }
      return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE,
        "action execution failed.");
    } finally {
      clearTimeout(timer);
    }

    if (frame.idempotencyKey) {
      this.idempotency.tryStore(frame.actionId, frame.idempotencyKey, {
        actionId: frame.actionId,
        paramsHash,
        result: result.result ?? null,
        anchorRef: result.anchorRef ?? spec.resultAnchor,
        expiresAt: this.clock() + this.opt.idempotencyTtlMs,
      });
    }

    return this.capsResponse(result.result ?? null, result.anchorRef ?? spec.resultAnchor, requestId, result.tokenEst ?? 0);
  }

  private async runAsyncTask(frame: ActionFrame, ctx: ActionContext, timeoutMs: number): Promise<void> {
    this.taskStore.tryTransition(ctx.taskId!, "pending", "running");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.provider.execute(frame, ctx, controller.signal);
      this.taskStore.complete(ctx.taskId!, res.result ?? null);
    } catch (e) {
      const msg = controller.signal.aborted ? "task timed out"
        : (e instanceof Error ? e.message : String(e));
      this.taskStore.fail(ctx.taskId!, { code: ErrorCodes.NWP_NODE_UNAVAILABLE, message: msg });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── system.task.status / system.task.cancel ──────────────────────────────────

  private handleSystemTaskStatus(frame: ActionFrame, requestId: string | null): Response {
    const taskId = readStringParam(frame.params, "task_id");
    if (!taskId) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        "params.task_id is required.");
    }
    const rec = this.taskStore.get(taskId);
    if (!rec) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_TASK_NOT_FOUND,
        `Unknown task_id '${taskId}'.`);
    }
    const status: Record<string, unknown> = {
      task_id: rec.taskId,
      status: rec.status,
      progress: rec.progress ?? null,
      created_at: new Date(rec.createdAt).toISOString(),
      updated_at: new Date(rec.updatedAt).toISOString(),
      request_id: rec.requestId ?? null,
      result: rec.result ?? null,
      error: rec.error ?? null,
    };
    return this.capsResponse(status, undefined, requestId);
  }

  private handleSystemTaskCancel(frame: ActionFrame, requestId: string | null): Response {
    const taskId = readStringParam(frame.params, "task_id");
    if (!taskId) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_ACTION_PARAMS_INVALID,
        "params.task_id is required.");
    }
    const rec = this.taskStore.get(taskId);
    if (!rec) {
      return this.errorResponse(404, "NPS-CLIENT-NOT-FOUND", ErrorCodes.NWP_TASK_NOT_FOUND,
        `Unknown task_id '${taskId}'.`);
    }
    if (rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled") {
      return this.errorResponse(409, "NPS-CLIENT-CONFLICT", ErrorCodes.NWP_TASK_ALREADY_CANCELLED,
        `Task '${taskId}' is already in a terminal state ('${rec.status}').`);
    }
    this.taskStore.cancel(taskId);
    return this.capsResponse({ task_id: taskId, status: "cancelled" }, undefined, requestId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private clampTimeout(requested: number, spec: ActionSpec): number {
    const specMax = spec.timeoutMsMax ?? this.opt.maxTimeoutMs;
    const hardMax = Math.min(specMax, this.opt.maxTimeoutMs);
    if (requested <= 0) return spec.timeoutMsDefault ?? this.opt.defaultTimeoutMs;
    return requested > hardMax ? hardMax : requested;
  }

  private asyncResponse(taskId: string, status: string, requestId: string | null, estimatedMs?: number): Response {
    const body: Record<string, unknown> = {
      task_id: taskId,
      status,
      poll_url: `${this.prefix}/invoke`,
    };
    if (estimatedMs !== undefined) body["estimated_ms"] = estimatedMs;
    if (requestId !== null) body["request_id"] = requestId;
    return new Response(JSON.stringify(body), {
      status: 202,
      headers: { "content-type": "application/json", [H.HDR_NODE_TYPE.toLowerCase()]: "action" },
    });
  }

  private capsResponse(payload: unknown, anchorRef: string | undefined, requestId: string | null, tokenEst = 0): Response {
    const data = payload === null || payload === undefined ? [] : [payload];
    const caps: Record<string, unknown> = {
      anchor_ref: anchorRef ?? "",
      count: data.length,
      data,
    };
    if (tokenEst > 0) caps["token_est"] = tokenEst;
    const headers: Record<string, string> = {
      "content-type": H.MIME_CAPSULE,
      [H.HDR_NODE_TYPE.toLowerCase()]: "action",
    };
    if (anchorRef !== undefined) headers[H.HDR_SCHEMA.toLowerCase()] = anchorRef;
    if (tokenEst > 0) headers[H.HDR_TOKENS.toLowerCase()] = String(tokenEst);
    if (requestId !== null) headers[H.HDR_REQUEST_ID.toLowerCase()] = requestId;
    return new Response(JSON.stringify(caps), { status: 200, headers });
  }

  private notFound(): Response {
    // Match .NET: an unmatched sub-path falls through to `next` (404 with no body).
    return new Response(null, { status: 404 });
  }

  private errorResponse(httpStatus: number, npsStatus: string, errorCode: string, message: string): Response {
    return new Response(JSON.stringify({ status: npsStatus, error: errorCode, message }), {
      status: httpStatus,
      headers: { "content-type": "application/json" },
    });
  }

  private actionsDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [actionId, spec] of Object.entries(this.opt.actions)) {
      const entry: Record<string, unknown> = { async: spec.async ?? false };
      if (spec.description !== undefined) entry["description"] = spec.description;
      if (spec.paramsAnchor !== undefined) entry["params_anchor"] = spec.paramsAnchor;
      if (spec.resultAnchor !== undefined) entry["result_anchor"] = spec.resultAnchor;
      if (spec.idempotent !== undefined) entry["idempotent"] = spec.idempotent;
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
    const m: Record<string, unknown> = {
      nwp: "0.4",
      node_id: o.nodeId,
      node_type: "action",
      display_name: o.displayName ?? null,
      wire_formats: ["ncp-capsule", "json"],
      preferred_format: "json",
      capabilities: { query: false, stream: false, token_budget_hint: true },
      auth: { required: o.requireAuth, identity_type: o.requireAuth ? "nip-cert" : "none" },
      endpoints: { invoke: `${base}/invoke`, schema: `${base}/.schema` },
    };
    return m;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function hashParams(params: Record<string, unknown> | undefined): string {
  const json = params === undefined || params === null ? "null" : JSON.stringify(params);
  return createHash("sha256").update(json).digest("hex").toUpperCase();
}

function readStringParam(params: Record<string, unknown> | undefined, name: string): string | null {
  if (!params || typeof params !== "object") return null;
  const v = (params as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
}

// Re-export store types for convenience.
export {
  type IActionTaskStore, type IIdempotencyCache, type IdempotentEntry,
  type ActionTaskRecord, InMemoryActionTaskStore, InMemoryIdempotencyCache,
} from "./action-task-store.js";
