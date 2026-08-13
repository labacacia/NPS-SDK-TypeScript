// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sortKeysStringify } from "../core/canonical-json.js";
import {
  LlmContextOperation,
  LlmContextReceiptDto,
  LlmContextState,
  LlmContextStatusDto,
  LlmMessageDto,
  LlmToolDefinitionDto,
} from "./llm.js";
import {
  NWP_ACTION_IDEMPOTENCY_CONFLICT,
  NWP_ACTION_PARAMS_INVALID,
  NWP_LLM_CONTEXT_BINDING_MISMATCH,
  NWP_LLM_CONTEXT_EXPIRED,
  NWP_LLM_CONTEXT_FORBIDDEN,
  NWP_LLM_CONTEXT_LIMIT_EXCEEDED,
  NWP_LLM_CONTEXT_NOT_FOUND,
  NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED,
  NWP_LLM_CONTEXT_VERSION_CONFLICT,
} from "./nwp-error-codes.js";

const COMPLETE_ACTION = "llm.complete";
const RELEASE_ACTION = "llm.context.release";
const CONTEXT_ID = /^[A-Za-z0-9_-]{22,128}$/;

export interface LlmContextOwner {
  readonly nid: string;
  readonly securityScope: string;
}

export interface LlmContextBinding {
  readonly model: string;
  readonly systemMessages: readonly LlmMessageDto[];
  readonly tools?: readonly LlmToolDefinitionDto[];
  readonly runtimeRevision: string;
}

export interface LlmContextMutationRequest {
  readonly operation: LlmContextOperation;
  readonly owner: LlmContextOwner;
  readonly contextId?: string;
  readonly baseVersion?: number;
  readonly binding: LlmContextBinding;
  readonly messages: readonly LlmMessageDto[];
  readonly ttlSeconds?: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface LlmContextSnapshot {
  readonly contextId: string;
  readonly version: number;
  readonly state: LlmContextState;
  readonly transcript: readonly LlmMessageDto[];
  readonly binding: LlmContextBinding;
  readonly expiresAt?: Date;
}

export class LlmContextStoreError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly currentVersion?: number,
  ) {
    super(message);
    this.name = "LlmContextStoreError";
  }
}

export interface LlmContextStoreOptions {
  readonly maxContextsPerPrincipal: number;
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
  readonly tombstoneSeconds: number;
  readonly idempotencyTtlMs: number;
  readonly supportedOperations: ReadonlySet<LlmContextOperation>;
  readonly clock: () => number;
  readonly contextIdFactory: () => string;
}

export interface LlmContextStoreDescriptor {
  readonly operations: readonly LlmContextOperation[];
  readonly persistence: "process";
  readonly maxContextsPerPrincipal: number;
  readonly maxTtlSeconds: number;
  readonly tombstoneSeconds: number;
}

interface Entry {
  contextId: string;
  owner: LlmContextOwner;
  version: number;
  state: LlmContextState;
  binding: LlmContextBinding;
  bindingFingerprint: string;
  transcript: LlmMessageDto[];
  ttlSeconds: number;
  expiresAt?: number;
  tombstoneUntil?: number;
  reservationId?: string;
}

interface IdempotencyEntry {
  state: "busy" | "completed" | "failed";
  retainUntil: number;
  requestId?: string;
  reservationId?: string;
  errorCode?: string;
  receipt?: LlmContextReceiptDto;
  contextId?: string;
  baseVersion?: number;
}

export class LlmContextMutationReservation {
  constructor(
    readonly reservationId: string,
    readonly request: LlmContextMutationRequest,
    readonly bindingFingerprint: string,
    readonly baseTranscript: readonly LlmMessageDto[],
    readonly effectiveTtlSeconds?: number,
    readonly parentContextId?: string,
    readonly parentVersion?: number,
  ) {}

  get operation(): LlmContextOperation { return this.request.operation; }
  get requestId(): string { return this.request.requestId; }
}

const DEFAULT_OPTIONS: LlmContextStoreOptions = {
  maxContextsPerPrincipal: 32,
  defaultTtlSeconds: 3600,
  maxTtlSeconds: 3600,
  tombstoneSeconds: 86400,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  supportedOperations: new Set<LlmContextOperation>(["create", "append", "fork", "reset", "release"]),
  clock: () => Date.now(),
  contextIdFactory: () => randomBytes(16).toString("base64url"),
};

/** Process-local reference implementation of the NWP 0.21 context state machine. */
export class InMemoryLlmContextStore {
  private readonly options: LlmContextStoreOptions;
  private readonly contexts = new Map<string, Entry>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly reservations = new Map<string, LlmContextMutationReservation>();

  constructor(options: Partial<LlmContextStoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get descriptor(): LlmContextStoreDescriptor {
    const order: readonly LlmContextOperation[] = ["create", "append", "fork", "reset", "release"];
    return Object.freeze({
      operations: Object.freeze(order.filter(operation => this.options.supportedOperations.has(operation))),
      persistence: "process" as const,
      maxContextsPerPrincipal: this.options.maxContextsPerPrincipal,
      maxTtlSeconds: this.options.maxTtlSeconds,
      tombstoneSeconds: this.options.tombstoneSeconds,
    });
  }

  reserve(request: LlmContextMutationRequest): LlmContextMutationReservation {
    this.sweep(this.now());
    this.validateRequest(request);
    this.ensureSupported(request.operation);
    const idemKey = this.ownerKey(request.owner, COMPLETE_ACTION, request.idempotencyKey);
    if (this.idempotency.has(idemKey)) {
      throw new LlmContextStoreError(
        NWP_ACTION_IDEMPOTENCY_CONFLICT,
        "An outcome already exists for this idempotency key.",
      );
    }

    let reservation: LlmContextMutationReservation;
    if (request.operation === "create") {
      this.ensureAllocationAvailable(request.owner);
      reservation = this.newReservation(
        request,
        [],
        this.clampTtl(request.ttlSeconds ?? this.options.defaultTtlSeconds),
      );
    } else {
      const entry = this.requireMutable(request.owner, request.contextId!);
      if (entry.reservationId !== undefined || entry.version !== request.baseVersion) {
        throw new LlmContextStoreError(
          NWP_LLM_CONTEXT_VERSION_CONFLICT,
          "The context version is stale or a mutation is running.",
          entry.version,
        );
      }
      const fingerprint = this.bindingFingerprint(request.binding);
      if ((request.operation === "append" || request.operation === "fork") &&
          entry.bindingFingerprint !== fingerprint) {
        throw new LlmContextStoreError(
          NWP_LLM_CONTEXT_BINDING_MISMATCH,
          "The request binding differs from the retained binding.",
        );
      }
      if (request.operation === "fork") this.ensureAllocationAvailable(request.owner);
      reservation = this.newReservation(
        request,
        [...entry.transcript],
        this.effectiveTtl(request, entry),
        request.operation === "fork" ? entry.contextId : undefined,
        request.operation === "fork" ? entry.version : undefined,
      );
      if (request.operation !== "fork") entry.reservationId = reservation.reservationId;
    }

    this.reservations.set(reservation.reservationId, reservation);
    this.idempotency.set(idemKey, {
      state: "busy",
      requestId: request.requestId,
      reservationId: reservation.reservationId,
      retainUntil: this.now() + this.options.idempotencyTtlMs,
    });
    return reservation;
  }

  commit(
    reservation: LlmContextMutationReservation,
    assistantResult: LlmMessageDto,
  ): LlmContextReceiptDto {
    const current = this.requireReservation(reservation);
    const request = current.request;
    const expiry = current.effectiveTtlSeconds === undefined
      ? undefined
      : this.now() + current.effectiveTtlSeconds * 1000;
    let entry: Entry;
    let contextId: string;
    let version: number;

    if (request.operation === "create" || request.operation === "fork") {
      contextId = this.nextContextId();
      version = 1;
      const transcript = request.operation === "fork" ? [...current.baseTranscript] : [];
      transcript.push(...request.messages.map(cloneMessage), cloneMessage(assistantResult));
      entry = {
        contextId,
        owner: request.owner,
        version,
        state: "active",
        binding: request.binding,
        bindingFingerprint: current.bindingFingerprint,
        transcript,
        ttlSeconds: current.effectiveTtlSeconds ?? 0,
        expiresAt: expiry,
      };
      this.contexts.set(contextId, entry);
    } else {
      entry = this.requireEntry(request.contextId!);
      contextId = entry.contextId;
      version = entry.version + 1;
      entry.version = version;
      entry.state = "active";
      entry.reservationId = undefined;
      entry.expiresAt = expiry;
      entry.ttlSeconds = current.effectiveTtlSeconds ?? 0;
      if (request.operation === "reset") {
        entry.binding = request.binding;
        entry.bindingFingerprint = current.bindingFingerprint;
        entry.transcript = [...request.messages.map(cloneMessage), cloneMessage(assistantResult)];
      } else {
        entry.transcript.push(...request.messages.map(cloneMessage), cloneMessage(assistantResult));
      }
    }

    const receipt: LlmContextReceiptDto = {
      contextId,
      version,
      operation: request.operation,
      state: "active",
      expiresAt: expiry === undefined ? undefined : new Date(expiry).toISOString(),
      parentContextId: current.parentContextId,
      parentVersion: current.parentVersion,
    };
    this.completeIdempotency(current, receipt);
    this.reservations.delete(current.reservationId);
    return receipt;
  }

  abort(reservation: LlmContextMutationReservation, errorCode?: string): void {
    const current = this.requireReservation(reservation);
    this.clearReservation(current);
    this.reservations.delete(current.reservationId);
    const request = current.request;
    this.idempotency.set(
      this.ownerKey(request.owner, COMPLETE_ACTION, request.idempotencyKey),
      {
        state: "failed",
        requestId: request.requestId,
        errorCode,
        retainUntil: this.now() + this.options.idempotencyTtlMs,
      },
    );
    this.sweep(this.now());
  }

  release(
    owner: LlmContextOwner,
    contextId: string,
    baseVersion: number,
    idempotencyKey: string,
  ): LlmContextReceiptDto {
    this.sweep(this.now());
    this.ensureSupported("release");
    this.validateContextId(contextId);
    if (idempotencyKey.trim() === "") this.paramsInvalid("release requires idempotency_key.");
    const key = this.ownerKey(owner, RELEASE_ACTION, idempotencyKey);
    const prior = this.idempotency.get(key);
    if (prior !== undefined) {
      if (prior.state === "completed" && prior.receipt !== undefined &&
          prior.contextId === contextId && prior.baseVersion === baseVersion) {
        return prior.receipt;
      }
      throw new LlmContextStoreError(
        NWP_ACTION_IDEMPOTENCY_CONFLICT,
        "A release with this idempotency key already exists.",
      );
    }
    const entry = this.requireMutable(owner, contextId);
    if (entry.reservationId !== undefined || entry.version !== baseVersion) {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_VERSION_CONFLICT,
        "The context version is stale or a mutation is running.",
        entry.version,
      );
    }
    entry.version++;
    entry.state = "released";
    entry.expiresAt = undefined;
    entry.tombstoneUntil = this.now() + this.options.tombstoneSeconds * 1000;
    const receipt: LlmContextReceiptDto = {
      contextId,
      version: entry.version,
      operation: "release",
      state: "released",
    };
    this.idempotency.set(key, {
      state: "completed",
      receipt,
      contextId,
      baseVersion,
      retainUntil: this.now() + this.options.idempotencyTtlMs,
    });
    return receipt;
  }

  status(
    owner: LlmContextOwner,
    locator: { contextId?: string; idempotencyKey?: string },
  ): LlmContextStatusDto {
    this.sweep(this.now());
    if ((locator.contextId === undefined) === (locator.idempotencyKey === undefined)) {
      this.paramsInvalid("status requires exactly one of context_id or idempotency_key.");
    }
    if (locator.idempotencyKey !== undefined) {
      const outcome = this.idempotency.get(
        this.ownerKey(owner, COMPLETE_ACTION, locator.idempotencyKey),
      );
      if (outcome === undefined) this.notFound();
      if (outcome.state === "busy") {
        return { state: "busy", requestId: outcome.requestId };
      }
      if (outcome.state === "failed") {
        return { state: "failed", requestId: outcome.requestId, errorCode: outcome.errorCode };
      }
      return this.statusFromReceipt(owner, outcome.receipt!);
    }

    this.validateContextId(locator.contextId!);
    const entry = this.contexts.get(locator.contextId!);
    if (entry === undefined) this.notFound();
    this.ensureOwner(entry, owner);
    const active = entry.reservationId === undefined
      ? undefined
      : this.reservations.get(entry.reservationId);
    return {
      state: entry.reservationId === undefined ? entry.state : "busy",
      contextId: entry.contextId,
      version: entry.version,
      expiresAt: entry.expiresAt === undefined ? undefined : new Date(entry.expiresAt).toISOString(),
      requestId: active?.requestId,
    };
  }

  snapshot(owner: LlmContextOwner, contextId: string): LlmContextSnapshot {
    this.sweep(this.now());
    const entry = this.requireMutable(owner, contextId);
    return {
      contextId: entry.contextId,
      version: entry.version,
      state: entry.state,
      transcript: entry.transcript.map(cloneMessage),
      binding: cloneBinding(entry.binding),
      expiresAt: entry.expiresAt === undefined ? undefined : new Date(entry.expiresAt),
    };
  }

  sweepExpired(): number { return this.sweep(this.now()); }

  private newReservation(
    request: LlmContextMutationRequest,
    transcript: readonly LlmMessageDto[],
    ttl?: number,
    parentContextId?: string,
    parentVersion?: number,
  ): LlmContextMutationReservation {
    const binding = cloneBinding(request.binding);
    const retainedRequest: LlmContextMutationRequest = {
      ...request,
      owner: { ...request.owner },
      binding,
      messages: request.messages.map(cloneMessage),
    };
    return new LlmContextMutationReservation(
      randomUUID(),
      retainedRequest,
      this.bindingFingerprint(binding),
      transcript.map(cloneMessage),
      ttl,
      parentContextId,
      parentVersion,
    );
  }

  private validateRequest(request: LlmContextMutationRequest): void {
    if (request.operation === "release") this.paramsInvalid("release uses the lifecycle action.");
    if (request.idempotencyKey.trim() === "") {
      this.paramsInvalid("A stateful request requires idempotency_key.");
    }
    if (request.ttlSeconds !== undefined &&
        (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds <= 0)) {
      this.paramsInvalid("ttl_seconds must be a positive integer.");
    }
    if (request.operation === "create") {
      if (request.contextId !== undefined || request.baseVersion !== undefined) {
        this.paramsInvalid("create forbids context_id and base_version.");
      }
    } else {
      if (request.contextId === undefined || request.baseVersion === undefined) {
        this.paramsInvalid("append/fork/reset require context_id and base_version.");
      }
      this.validateContextId(request.contextId);
    }
    if (request.operation !== "fork" && request.messages.length === 0) {
      this.paramsInvalid("Only fork may carry an empty message delta.");
    }
    if ((request.operation === "append" || request.operation === "fork") &&
        request.messages.some(message => message.role.toLowerCase() === "system")) {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_BINDING_MISMATCH,
        "append/fork deltas must not contain system messages.",
      );
    }
  }

  private effectiveTtl(request: LlmContextMutationRequest, entry: Entry): number | undefined {
    if (request.ttlSeconds !== undefined) return this.clampTtl(request.ttlSeconds);
    if (request.operation === "fork") {
      return entry.expiresAt === undefined
        ? undefined
        : Math.max(1, Math.ceil((entry.expiresAt - this.now()) / 1000));
    }
    return entry.ttlSeconds || undefined;
  }

  private ensureAllocationAvailable(owner: LlmContextOwner): void {
    const live = [...this.contexts.values()].filter(
      entry => this.sameOwner(entry.owner, owner) && entry.state === "active",
    ).length;
    const pending = [...this.reservations.values()].filter(
      item => this.sameOwner(item.request.owner, owner) &&
        (item.operation === "create" || item.operation === "fork"),
    ).length;
    if (live + pending >= this.options.maxContextsPerPrincipal) {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_LIMIT_EXCEEDED,
        "The principal's live context limit has been reached.",
      );
    }
  }

  private ensureSupported(operation: LlmContextOperation): void {
    if (!this.options.supportedOperations.has(operation)) {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED,
        `Context operation '${operation}' is not advertised.`,
      );
    }
  }

  private requireMutable(owner: LlmContextOwner, contextId: string): Entry {
    const entry = this.requireEntry(contextId);
    this.ensureOwner(entry, owner);
    if (entry.state === "expired") {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_EXPIRED,
        "The context expired.",
        entry.version,
      );
    }
    if (entry.state === "released") this.notFound();
    return entry;
  }

  private requireEntry(contextId: string): Entry {
    const entry = this.contexts.get(contextId);
    if (entry === undefined) this.notFound();
    return entry;
  }

  private requireReservation(
    reservation: LlmContextMutationReservation,
  ): LlmContextMutationReservation {
    const current = this.reservations.get(reservation.reservationId);
    if (current !== reservation) throw new Error("The context reservation is not active.");
    return current;
  }

  private clearReservation(reservation: LlmContextMutationReservation): void {
    const contextId = reservation.request.contextId;
    const entry = contextId === undefined ? undefined : this.contexts.get(contextId);
    if (entry?.reservationId === reservation.reservationId) entry.reservationId = undefined;
  }

  private completeIdempotency(
    reservation: LlmContextMutationReservation,
    receipt: LlmContextReceiptDto,
  ): void {
    const request = reservation.request;
    this.idempotency.set(
      this.ownerKey(request.owner, COMPLETE_ACTION, request.idempotencyKey),
      {
        state: "completed",
        requestId: request.requestId,
        receipt,
        retainUntil: this.now() + this.options.idempotencyTtlMs,
      },
    );
  }

  private statusFromReceipt(
    owner: LlmContextOwner,
    receipt: LlmContextReceiptDto,
  ): LlmContextStatusDto {
    if (this.contexts.has(receipt.contextId)) {
      return this.status(owner, { contextId: receipt.contextId });
    }
    return {
      state: receipt.state,
      contextId: receipt.contextId,
      version: receipt.version,
      expiresAt: receipt.expiresAt,
    };
  }

  private nextContextId(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const contextId = this.options.contextIdFactory();
      this.validateContextId(contextId);
      if (!this.contexts.has(contextId)) return contextId;
    }
    throw new Error("Context ID factory repeatedly produced collisions.");
  }

  private sweep(now: number): number {
    let changed = 0;
    for (const entry of this.contexts.values()) {
      if (entry.state === "active" && entry.reservationId === undefined &&
          entry.expiresAt !== undefined && entry.expiresAt <= now) {
        entry.state = "expired";
        entry.expiresAt = undefined;
        entry.tombstoneUntil = now + this.options.tombstoneSeconds * 1000;
        changed++;
      }
    }
    for (const [key, entry] of this.contexts) {
      if ((entry.state === "expired" || entry.state === "released") &&
          entry.tombstoneUntil !== undefined && entry.tombstoneUntil <= now) {
        this.contexts.delete(key);
        changed++;
      }
    }
    for (const [key, entry] of this.idempotency) {
      if (entry.state !== "busy" && entry.retainUntil <= now) {
        this.idempotency.delete(key);
        changed++;
      }
    }
    return changed;
  }

  private bindingFingerprint(binding: LlmContextBinding): string {
    const canonical = sortKeysStringify({
      model: binding.model,
      system_messages: binding.systemMessages,
      tools: binding.tools ?? null,
      runtime_revision: binding.runtimeRevision,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  private clampTtl(seconds: number): number { return Math.min(seconds, this.options.maxTtlSeconds); }
  private now(): number { return this.options.clock(); }

  private ownerKey(owner: LlmContextOwner, action: string, key: string): string {
    return `${owner.nid}\x1f${owner.securityScope}\x1f${action}\x1f${key}`;
  }

  private sameOwner(left: LlmContextOwner, right: LlmContextOwner): boolean {
    return left.nid === right.nid && left.securityScope === right.securityScope;
  }

  private ensureOwner(entry: Entry, owner: LlmContextOwner): void {
    if (!this.sameOwner(entry.owner, owner)) {
      throw new LlmContextStoreError(
        NWP_LLM_CONTEXT_FORBIDDEN,
        "The caller does not own this context.",
      );
    }
  }

  private validateContextId(value: string): void {
    if (!CONTEXT_ID.test(value)) {
      this.paramsInvalid("context_id must be a 22-128 character unpadded base64url locator.");
    }
  }

  private paramsInvalid(message: string): never {
    throw new LlmContextStoreError(NWP_ACTION_PARAMS_INVALID, message);
  }

  private notFound(): never {
    throw new LlmContextStoreError(
      NWP_LLM_CONTEXT_NOT_FOUND,
      "The context or retained outcome was not found.",
    );
  }
}

function cloneMessage(value: LlmMessageDto): LlmMessageDto {
  return {
    ...value,
    toolCalls: value.toolCalls?.map(call => ({ ...call })),
  };
}

function cloneBinding(value: LlmContextBinding): LlmContextBinding {
  return {
    model: value.model,
    runtimeRevision: value.runtimeRevision,
    systemMessages: value.systemMessages.map(cloneMessage),
    tools: value.tools?.map(tool => ({
      ...tool,
      parameters: tool.parameters?.map(parameter => ({ ...parameter })),
    })),
  };
}
