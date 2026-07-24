// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { EncodingTier, FrameType } from "../core/frames.js";
import type { NpsFrame } from "../core/codec.js";
import type { AggregateStrategy, TaskContext, TaskDag, TaskPriority } from "./models.js";

// ── TaskFrame ─────────────────────────────────────────────────────────────────

export class TaskFrame implements NpsFrame {
  readonly frameType     = FrameType.TASK;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:               string,
    public readonly dag:                  TaskDag,
    public readonly timeoutMs?:           number,
    public readonly callbackUrl?:         string,
    public readonly context?:             TaskContext,
    public readonly priority?:            TaskPriority,
    public readonly depth?:               number,
    public readonly compensationPolicy?:  string,
    public readonly resultTtlSeconds:     number = 3600, // NOP v0.7
    public readonly maxRetries:           number = 2,
    public readonly callbackSecret?:      string,
    public readonly preflight:            boolean = false,
    public readonly requestId?:           string,
  ) {}

  /** Alias for {@link depth}, matching the .NET `delegate_depth` wire field. */
  get delegateDepth(): number { return this.depth ?? 0; }

  toDict(): Record<string, unknown> {
    return {
      task_id:             this.taskId,
      dag:                 this.dag,
      timeout_ms:          this.timeoutMs          ?? null,
      max_retries:         this.maxRetries,
      priority:            this.priority            ?? null,
      callback_url:        this.callbackUrl         ?? null,
      callback_secret:     this.callbackSecret      ?? null,
      preflight:           this.preflight,
      context:             this.context             ?? null,
      request_id:          this.requestId           ?? null,
      delegate_depth:      this.depth               ?? 0,
      compensation_policy: this.compensationPolicy  ?? 'best_effort',
      result_ttl_seconds:  this.resultTtlSeconds,
    };
  }

  static fromDict(data: Record<string, unknown>): TaskFrame {
    // Accept both the legacy `depth` and the .NET `delegate_depth` wire names.
    const depth = (data["delegate_depth"] as number | null) ??
                  (data["depth"] as number | null) ?? undefined;
    return new TaskFrame(
      data["task_id"]             as string,
      data["dag"]                 as TaskDag,
      (data["timeout_ms"]          as number | null) ?? undefined,
      (data["callback_url"]        as string | null) ?? undefined,
      (data["context"]             as TaskContext | null) ?? undefined,
      (data["priority"]            as TaskPriority | null) ?? undefined,
      depth,
      (data["compensation_policy"] as string | null) ?? undefined,
      (data["result_ttl_seconds"]  as number | null) ?? 3600,
      (data["max_retries"]         as number | null) ?? 2,
      (data["callback_secret"]     as string | null) ?? undefined,
      (data["preflight"]           as boolean | null) ?? false,
      (data["request_id"]          as string | null) ?? undefined,
    );
  }
}

// ── DelegateFrame ─────────────────────────────────────────────────────────────

export class DelegateFrame implements NpsFrame {
  readonly frameType     = FrameType.DELEGATE;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:                string,
    public readonly subtaskId:             string,
    public readonly action:                string,
    public readonly agentNid:              string,
    public readonly inputs?:               Record<string, unknown>,
    public readonly params?:               Record<string, unknown>,
    public readonly idempotencyKey?:       string,
    public readonly targetClusterAnchor?:  string,
    // NPS-5 §3.2 orchestration fields (populated by NopOrchestrator).
    public readonly nodeId?:               string,
    public readonly deadlineAt?:           string,
    public readonly priority?:             string,
    public readonly delegateDepth:         number = 0,
    public readonly context?:              unknown,
  ) {}

  /** Alias for {@link taskId}, matching the .NET `parent_task_id` wire field. */
  get parentTaskId(): string { return this.taskId; }
  /** Alias for {@link agentNid}, matching the .NET `target_agent_nid` wire field. */
  get targetAgentNid(): string { return this.agentNid; }

  toDict(): Record<string, unknown> {
    return {
      parent_task_id:        this.taskId,
      subtask_id:            this.subtaskId,
      node_id:               this.nodeId                ?? null,
      target_agent_nid:      this.agentNid,
      action:                this.action,
      inputs:                this.inputs                ?? null,
      params:                this.params                ?? null,
      deadline_at:           this.deadlineAt            ?? null,
      idempotency_key:       this.idempotencyKey        ?? null,
      priority:              this.priority              ?? null,
      delegate_depth:        this.delegateDepth,
      context:               this.context               ?? null,
      target_cluster_anchor: this.targetClusterAnchor   ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): DelegateFrame {
    return new DelegateFrame(
      (data["parent_task_id"] ?? data["task_id"]) as string,
      data["subtask_id"]            as string,
      data["action"]                as string,
      (data["target_agent_nid"] ?? data["agent_nid"]) as string,
      (data["inputs"]                as Record<string, unknown> | null) ?? undefined,
      (data["params"]                as Record<string, unknown> | null) ?? undefined,
      (data["idempotency_key"]       as string | null) ?? undefined,
      (data["target_cluster_anchor"] as string | null) ?? undefined,
      (data["node_id"]               as string | null) ?? undefined,
      (data["deadline_at"]           as string | null) ?? undefined,
      (data["priority"]              as string | null) ?? undefined,
      (data["delegate_depth"]        as number | null) ?? 0,
      data["context"] ?? undefined,
    );
  }
}

// ── SyncFrame ─────────────────────────────────────────────────────────────────

export class SyncFrame implements NpsFrame {
  readonly frameType     = FrameType.SYNC;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:      string,
    public readonly syncId:      string,
    public readonly waitFor:     readonly string[],
    public readonly minRequired: number = 0,
    public readonly aggregate:   AggregateStrategy | string = "merge",
    public readonly timeoutMs?:  number,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      task_id:      this.taskId,
      sync_id:      this.syncId,
      wait_for:     this.waitFor,
      min_required: this.minRequired,
      aggregate:    this.aggregate,
      timeout_ms:   this.timeoutMs ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): SyncFrame {
    return new SyncFrame(
      data["task_id"]      as string,
      data["sync_id"]      as string,
      data["wait_for"]     as string[],
      (data["min_required"] as number) ?? 0,
      (data["aggregate"]    as string) ?? "merge",
      (data["timeout_ms"]   as number | null) ?? undefined,
    );
  }
}

// ── StreamError ───────────────────────────────────────────────────────────────

export interface StreamError {
  errorCode: string;
  message?:  string;
}

// ── AlignStreamFrame ──────────────────────────────────────────────────────────

export class AlignStreamFrame implements NpsFrame {
  readonly frameType     = FrameType.ALIGN_STREAM;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly streamId:    string,
    public readonly taskId:      string,
    public readonly subtaskId:   string,
    public readonly seq:         number,
    public readonly isFinal:     boolean,
    public readonly senderNid:   string,
    public readonly data?:       Record<string, unknown>,
    public readonly error?:      StreamError,
    public readonly windowSize?: number,
    public readonly ackSeq?:     number,
    public readonly nakSeq?:     number,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      stream_id:   this.streamId,
      task_id:     this.taskId,
      subtask_id:  this.subtaskId,
      seq:         this.seq,
      is_final:    this.isFinal,
      sender_nid:  this.senderNid,
      data:        this.data        ?? null,
      error:       this.error ? { error_code: this.error.errorCode, message: this.error.message ?? null } : null,
      window_size: this.windowSize  ?? null,
      ack_seq:     this.ackSeq      ?? null,
      nak_seq:     this.nakSeq      ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): AlignStreamFrame {
    const rawError = data["error"] as { error_code: string; message?: string } | null;
    return new AlignStreamFrame(
      data["stream_id"]  as string,
      data["task_id"]    as string,
      data["subtask_id"] as string,
      data["seq"]        as number,
      data["is_final"]   as boolean,
      data["sender_nid"] as string,
      (data["data"]        as Record<string, unknown> | null) ?? undefined,
      rawError ? { errorCode: rawError.error_code, ...(rawError.message != null ? { message: rawError.message } : {}) } : undefined,
      (data["window_size"] as number | null) ?? undefined,
      (data["ack_seq"]     as number | null) ?? undefined,
      (data["nak_seq"]     as number | null) ?? undefined,
    );
  }
}
