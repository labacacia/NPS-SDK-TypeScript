// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NPS NWP — Memory Node server (Web-standard Fetch handler, zero deps).
 *
 * Faithful port of the .NET `MemoryNodeMiddleware` wire contract (NPS-2 §2.1, §5).
 * Same shape as {@link AnchorNodeApp}: {@link MemoryNodeApp.fetch} takes a `Request`
 * and returns a `Response`. Sub-paths under `pathPrefix`: `/.nwm`, `/.schema`,
 * `/query`, `/stream`.
 *
 * SQL providers + filter→SQL translation are DEFERRED. The provider interface is
 * kept clean; {@link InMemoryMemoryNodeProvider} performs in-memory filtering (NWP
 * Filter DSL) for tests and small datasets.
 */

import { createHash } from "node:crypto";
import { QueryFrame } from "./frames.js";
import type { FrameSchema } from "../ncp/frames/anchor-frame.js";
import * as ErrorCodes from "./nwp-error-codes.js";
import * as H from "./http-headers.js";

// ── Schema types ────────────────────────────────────────────────────────────────

/** Describes a single field in a Memory Node schema (NPS-2 §4.1). */
export interface MemoryNodeField {
  name: string;
  /** NWP field type: "string" | "number" | "boolean" | "datetime" | "object" | ... */
  type: string;
  description?: string;
  /** Whether this field may be null. Default true. */
  nullable?: boolean;
  /** Underlying DB column name, if different from `name`. */
  columnName?: string;
}

/** Schema definition for a Memory Node — describes the table it exposes. */
export interface MemoryNodeSchema {
  /** Database table (or view) name. */
  tableName: string;
  /** Primary key field name; used for cursor-based pagination. */
  primaryKey: string;
  /** All queryable fields. Must contain at least the primary key. */
  fields: MemoryNodeField[];
}

export function getSchemaField(schema: MemoryNodeSchema, name: string): MemoryNodeField | undefined {
  return schema.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

// ── Options (NPS-2 §2.1) ────────────────────────────────────────────────────────

export interface MemoryNodeOptions {
  /** Node NID, e.g. `urn:nps:node:api.example.com:products`. */
  nodeId: string;
  displayName?: string;
  /** Schema describing the table this node exposes. */
  schema: MemoryNodeSchema;
  /** HTTP path prefix, e.g. "/products". */
  pathPrefix: string;
  /** Default page size when QueryFrame.limit is absent. Default 20. */
  defaultLimit?: number;
  /** Hard cap on QueryFrame.limit. Default 1000. */
  maxLimit?: number;
  /** When true, requests without X-NWP-Agent are rejected with 401. */
  requireAuth?: boolean;
  /** Default token budget when X-NWP-Budget is absent. 0 = unlimited. */
  defaultTokenBudget?: number;
}

// ── Provider interface ──────────────────────────────────────────────────────────

export type MemoryNodeRow = Record<string, unknown>;

export interface MemoryNodeQueryResult {
  rows: MemoryNodeRow[];
  nextCursor?: string;
}

/** Abstraction over a data source backing a Memory Node (NPS-2 §2.1). */
export interface IMemoryNodeProvider {
  query(frame: QueryFrame, schema: MemoryNodeSchema, options: MemoryNodeOptions, signal?: AbortSignal): Promise<MemoryNodeQueryResult>;
  /** Optional streaming support (NDJSON / `/stream`); yields one page per StreamFrame chunk. */
  stream?(frame: QueryFrame, schema: MemoryNodeSchema, options: MemoryNodeOptions, signal?: AbortSignal): AsyncIterable<MemoryNodeRow[]>;
}

/** Error a provider may throw to signal a filter/field problem (mapped to 400). */
export class MemoryFilterError extends Error {
  constructor(public readonly nwpErrorCode: string, message: string) {
    super(message);
    this.name = "MemoryFilterError";
  }
}

// ── In-memory provider (in-memory NWP Filter DSL) ───────────────────────────────

/**
 * Reference in-memory provider. Applies the NWP Filter DSL, ordering, field
 * projection, and limit/offset in memory. SQL providers are deferred; this is the
 * clean-interface reference used by tests.
 */
export class InMemoryMemoryNodeProvider implements IMemoryNodeProvider {
  constructor(private readonly data: MemoryNodeRow[] = []) {}

  async query(frame: QueryFrame, schema: MemoryNodeSchema, options: MemoryNodeOptions): Promise<MemoryNodeQueryResult> {
    // Field validation (unknown fields → NWP-QUERY-FIELD-UNKNOWN).
    if (frame.fields) {
      for (const f of frame.fields) {
        if (!getSchemaField(schema, f)) {
          throw new MemoryFilterError(ErrorCodes.NWP_QUERY_FIELD_UNKNOWN, `Unknown field '${f}'.`);
        }
      }
    }

    let rows = this.data.filter((row) => matchFilter(row, frame.filter));

    if (frame.orderBy && frame.orderBy.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const clause of frame.orderBy!) {
          const dir = clause.dir.toLowerCase() === "desc" ? -1 : 1;
          const cmp = compareValues(a[clause.field], b[clause.field]);
          if (cmp !== 0) return cmp * dir;
        }
        return 0;
      });
    }

    const offset = frame.offset ?? 0;
    const limit = Math.min(frame.limit ?? options.defaultLimit ?? 20, options.maxLimit ?? 1000);
    const page = rows.slice(offset, offset + limit);

    const projected = frame.fields
      ? page.map((row) => {
          const out: MemoryNodeRow = {};
          for (const f of frame.fields!) if (f in row) out[f] = row[f];
          return out;
        })
      : page;

    return { rows: projected };
  }

  async *stream(frame: QueryFrame, schema: MemoryNodeSchema, options: MemoryNodeOptions): AsyncIterable<MemoryNodeRow[]> {
    const result = await this.query(frame, schema, options);
    yield result.rows;
  }
}

// ── The Fetch app ───────────────────────────────────────────────────────────────

export class MemoryNodeApp {
  private readonly opt: Required<Pick<MemoryNodeOptions,
    "defaultLimit" | "maxLimit" | "requireAuth" | "defaultTokenBudget">> & MemoryNodeOptions;
  private readonly prefix: string;
  private readonly provider: IMemoryNodeProvider;
  private readonly anchorId: string;
  private readonly nwmJson: string;
  private readonly schemaJson: string;

  constructor(provider: IMemoryNodeProvider, options: MemoryNodeOptions) {
    this.opt = {
      defaultLimit: 20,
      maxLimit: 1000,
      requireAuth: false,
      defaultTokenBudget: 0,
      ...options,
    };
    this.prefix = options.pathPrefix.replace(/\/+$/, "");
    this.provider = provider;

    const built = this.buildStaticPayloads();
    this.anchorId = built.anchorId;
    this.schemaJson = built.schemaJson;
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
          headers: { "content-type": H.MIME_MANIFEST, [H.HDR_NODE_TYPE.toLowerCase()]: "memory" },
        });
      case "/.schema":
      case "/.schema/":
        return new Response(this.schemaJson, {
          status: 200,
          headers: { "content-type": "application/json", [H.HDR_SCHEMA.toLowerCase()]: this.anchorId },
        });
      case "/query":
      case "/query/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleQuery(req);
      case "/stream":
      case "/stream/":
        if (req.method !== "POST") return new Response(null, { status: 405 });
        return this.handleStream(req);
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

    const budget = effectiveBudget(parseBudget(req), this.opt.defaultTokenBudget);

    let result: MemoryNodeQueryResult;
    try {
      result = await this.provider.query(frame, this.opt.schema, this.opt);
    } catch (e) {
      if (e instanceof MemoryFilterError) {
        return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", e.nwpErrorCode, e.message);
      }
      return this.errorResponse(500, "NPS-SERVER-INTERNAL", ErrorCodes.NWP_NODE_UNAVAILABLE, "Internal server error.");
    }

    let rows = result.rows;
    let tokenEst = measureRows(rows);
    if (budget > 0 && tokenEst > budget) {
      ({ rows, tokenEst } = trimToBudget(rows, budget));
    }

    const caps: Record<string, unknown> = {
      anchor_ref: this.anchorId,
      count: rows.length,
      data: rows,
      next_cursor: result.nextCursor ?? null,
      token_est: tokenEst,
    };
    return new Response(JSON.stringify(caps), {
      status: 200,
      headers: {
        "content-type": H.MIME_CAPSULE,
        [H.HDR_SCHEMA.toLowerCase()]: this.anchorId,
        [H.HDR_TOKENS.toLowerCase()]: String(tokenEst),
        [H.HDR_NODE_TYPE.toLowerCase()]: "memory",
      },
    });
  }

  // ── /stream ──────────────────────────────────────────────────────────────────

  private async handleStream(req: Request): Promise<Response> {
    let frame: QueryFrame;
    try {
      frame = QueryFrame.fromDict((await req.json()) as Record<string, unknown>);
    } catch (e) {
      return this.errorResponse(400, "NPS-CLIENT-BAD-REQUEST", ErrorCodes.NWP_QUERY_FILTER_INVALID, String(e));
    }

    const anchorId = this.anchorId;
    const provider = this.provider;
    const schema = this.opt.schema;
    const opts = this.opt;
    const streamId = randomStreamId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const writeLine = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        let seq = 0;
        try {
          if (provider.stream) {
            for await (const page of provider.stream(frame, schema, opts)) {
              const first = seq === 0;
              const chunk: Record<string, unknown> = { stream_id: streamId, seq: seq++, is_last: false, data: page };
              if (first) chunk["anchor_ref"] = anchorId;
              writeLine(chunk);
            }
          } else {
            const result = await provider.query(frame, schema, opts);
            writeLine({ stream_id: streamId, seq: seq++, is_last: false, anchor_ref: anchorId, data: result.rows });
          }
          writeLine({ stream_id: streamId, seq, is_last: true, data: [] });
        } catch (e) {
          const code = e instanceof MemoryFilterError ? e.nwpErrorCode : ErrorCodes.NWP_NODE_UNAVAILABLE;
          writeLine({ stream_id: streamId, seq, is_last: true, data: [], error_code: code });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": H.MIME_CAPSULE,
        [H.HDR_SCHEMA.toLowerCase()]: anchorId,
        [H.HDR_NODE_TYPE.toLowerCase()]: "memory",
      },
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private errorResponse(httpStatus: number, npsStatus: string, errorCode: string, message: string): Response {
    return new Response(JSON.stringify({ status: npsStatus, error: errorCode, message }), {
      status: httpStatus,
      headers: { "content-type": "application/json" },
    });
  }

  private buildStaticPayloads(): { anchorId: string; schemaJson: string; nwmJson: string } {
    const base = this.prefix;
    const frameSchema: FrameSchema = {
      fields: this.opt.schema.fields.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable ?? true })),
    };
    const schemaJson = JSON.stringify(frameSchema);
    const anchorId = "sha256:" + createHash("sha256").update(schemaJson).digest("hex");

    const m: Record<string, unknown> = {
      nwp: "0.4",
      node_id: this.opt.nodeId,
      node_type: "memory",
      display_name: this.opt.displayName ?? null,
      wire_formats: ["ncp-capsule", "json"],
      preferred_format: "json",
      schema_anchors: { default: anchorId },
      capabilities: { query: true, stream: true, token_budget_hint: true },
      auth: { required: this.opt.requireAuth, identity_type: this.opt.requireAuth ? "nip-cert" : "none" },
      endpoints: { query: `${base}/query`, stream: `${base}/stream`, schema: `${base}/.schema` },
    };
    return { anchorId, schemaJson, nwmJson: JSON.stringify(m) };
  }
}

// ── NWP Filter DSL (in-memory) ──────────────────────────────────────────────────

function matchFilter(row: MemoryNodeRow, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(cond) || !cond.every((c) => matchFilter(row, c as Record<string, unknown>))) return false;
    } else if (key === "$or") {
      if (!Array.isArray(cond) || !cond.some((c) => matchFilter(row, c as Record<string, unknown>))) return false;
    } else if (key === "$not") {
      if (matchFilter(row, cond as Record<string, unknown>)) return false;
    } else {
      if (!matchFieldCondition(row[key], cond)) return false;
    }
  }
  return true;
}

function matchFieldCondition(value: unknown, cond: unknown): boolean {
  // Bare value → implicit $eq.
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
    return deepEqual(value, cond);
  }
  for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
    switch (op) {
      case "$eq":  if (!deepEqual(value, operand)) return false; break;
      case "$ne":  if (deepEqual(value, operand)) return false; break;
      case "$lt":  if (!(compareValues(value, operand) < 0)) return false; break;
      case "$lte": if (!(compareValues(value, operand) <= 0)) return false; break;
      case "$gt":  if (!(compareValues(value, operand) > 0)) return false; break;
      case "$gte": if (!(compareValues(value, operand) >= 0)) return false; break;
      case "$in":  if (!Array.isArray(operand) || !operand.some((o) => deepEqual(value, o))) return false; break;
      case "$nin": if (Array.isArray(operand) && operand.some((o) => deepEqual(value, o))) return false; break;
      case "$contains":
        if (typeof value === "string" && typeof operand === "string") {
          if (!value.includes(operand)) return false;
        } else if (Array.isArray(value)) {
          if (!value.some((v) => deepEqual(v, operand))) return false;
        } else {
          return false;
        }
        break;
      case "$between":
        if (!Array.isArray(operand) || operand.length !== 2) return false;
        if (!(compareValues(value, operand[0]) >= 0 && compareValues(value, operand[1]) <= 0)) return false;
        break;
      default:
        throw new MemoryFilterError(ErrorCodes.NWP_QUERY_FILTER_INVALID, `Unsupported filter operator '${op}'.`);
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// ── Budget / CGN helpers ────────────────────────────────────────────────────────

function parseBudget(req: Request): number {
  const raw = req.headers.get(H.HDR_BUDGET);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

function effectiveBudget(agentBudget: number, cgnLimit: number): number {
  if (cgnLimit <= 0) return agentBudget;
  if (agentBudget <= 0) return cgnLimit;
  return Math.min(cgnLimit, agentBudget);
}

/** CGN = ceil(UTF-8 bytes / 4) — the token-budget.md fallback. */
function measureRows(rows: MemoryNodeRow[]): number {
  let total = 0;
  for (const row of rows) total += Math.ceil(new TextEncoder().encode(JSON.stringify(row)).length / 4);
  return total;
}

function trimToBudget(rows: MemoryNodeRow[], budget: number): { rows: MemoryNodeRow[]; tokenEst: number } {
  const trimmed: MemoryNodeRow[] = [];
  let acc = 0;
  for (const row of rows) {
    const tok = Math.ceil(new TextEncoder().encode(JSON.stringify(row)).length / 4);
    if (acc + tok > budget) break;
    trimmed.push(row);
    acc += tok;
  }
  return { rows: trimmed, tokenEst: acc };
}

function randomStreamId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
