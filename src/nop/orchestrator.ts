// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NOP DAG Orchestrator — TypeScript port of NPS.NOP.NopOrchestrator (NPS-5 §3, §5).
//
// Accepts a TaskFrame and runs its DAG by dispatching sub-tasks to Worker Agents,
// with full parity to the .NET reference:
//   - ExecuteAsync ordering: depth guard → callback-url validation → DAG validation
//     → duplicate reject → persist → timeout min(task, MaxTimeoutMs) → optional
//     preflight (dedup by agent) → run DAG → finalize → fire callback.
//   - Ready-node scheduling with K-of-N (min_required), MaxConcurrentNodes,
//     condition-skip (evaluated once), retry w/ backoff + retry_on, abort only when
//     an end node can no longer satisfy its K, saga compensation in reverse topo
//     order (strict vs best_effort), end-node result aggregation.
//   - HMAC-SHA256 callback (X-NPS-Signature: sha256=<lowerhex>) via Web Crypto,
//     exponential-backoff retry, non-fatal.
//
// The engine supports two worker abstractions:
//   - INopWorkerClient  — streaming AlignStreamFrame + preflight (full .NET parity).
//   - INopWorkerDispatcher — a simpler single-call dispatch used by earlier tests.

import type { DagNode, TaskDag } from "./models.js";
import { TaskState, CompensationPolicy } from "./models.js";
import { validateDag } from "./dag-validator.js";
import type { TaskFrame } from "./frames.js";
import { DelegateFrame } from "./frames.js";
import { NopConstants } from "./constants.js";
import {
  NOP_DELEGATE_CHAIN_TOO_DEEP,
  NOP_TASK_DAG_INVALID,
  NOP_TASK_ALREADY_COMPLETED,
  NOP_TASK_TIMEOUT,
  NOP_TASK_CANCELLED,
  NOP_SYNC_DEPENDENCY_FAILED,
  NOP_CONDITION_EVAL_ERROR,
  NOP_DELEGATE_TIMEOUT,
  NOP_STREAM_SEQ_GAP,
  NOP_STREAM_NID_MISMATCH,
  NOP_RESOURCE_INSUFFICIENT,
  NOP_COMPENSATION_FAILED,
  NOP_COMPENSATION_NOT_SUPPORTED,
} from "./nop-error-codes.js";
import { validateCallbackUrl } from "./callback-validator.js";
import { evaluateCondition, NopConditionError } from "./condition-evaluator.js";
import { buildParams, NopMappingError } from "./input-mapper.js";
import { aggregateEndNodes } from "./result-aggregator.js";
import type {
  INopWorkerClient,
  PreflightResult,
  SagaCompensationResult,
} from "./worker-client.js";
import type { ClusterDelegationResolver } from "./cluster-delegation.js";
import { NWP_ANCHOR_NOT_LEADER } from "../nwp/nwp-error-codes.js";

// ── Public result types ─────────────────────────────────────────────────────

export interface NopTaskRecord {
  taskId:      string;
  frame:       TaskFrame;
  state:       TaskState;
  startedAt:   Date;
  completedAt?: Date;
  nodeResults: Map<string, NodeResult>;
  error?:      { code: string; message: string };
}

export interface NodeResult {
  nodeId:   string;
  ok:       boolean;
  output?:  unknown;
  error?:   { code: string; message: string };
  skipped?: boolean;
}

export interface NopTaskResult {
  taskId:            string;
  state:             TaskState;
  aggregatedResult?: unknown;
  nodeResults:       Record<string, NodeResult>;
  error?:            { code: string; message: string };
  compensation?:     SagaCompensationResult;
}

/** Simpler single-call dispatch abstraction (kept for backward compatibility). */
export interface INopWorkerDispatcher {
  dispatch(nodeId: string, node: DagNode, params: unknown, deadlineMs: number, targetNid?: string): Promise<NodeResult>;
}

export interface NopOrchestratorOptions {
  defaultTimeoutMs?: number;
  maxTimeoutMs?:     number;
  /** Max DAG nodes that may execute concurrently per task. Default: 8. */
  maxConcurrentNodes?: number;
  /** Validate AlignStreamFrame.senderNid against the node agent NID. Default: true. */
  validateSenderNid?: boolean;
  /** POST the result to callback_url on completion (fire-and-forget). Default: true. */
  enableCallback?: boolean;
  /** HTTP timeout for callback POSTs (ms). Default: 10000. */
  callbackTimeoutMs?: number;
  /** Base delay (ms) for exponential callback-retry backoff. Set 0 in tests. Default: 1000. */
  callbackRetryBaseDelayMs?: number;
  /** Default aggregate strategy for end nodes when no SyncFrame is present. Default: "merge". */
  defaultAggregateStrategy?: string;
  /** Resolve cluster-targeted DAG nodes to the current active Anchor (NPS-CR-0009). */
  clusterResolver?: ClusterDelegationResolver;
}

// ── In-memory task store ──────────────────────────────────────────────────────

export class InMemoryNopTaskStore {
  private readonly _tasks = new Map<string, NopTaskRecord>();

  get(taskId: string): NopTaskRecord | undefined { return this._tasks.get(taskId); }
  save(record: NopTaskRecord):   void { this._tasks.set(record.taskId, record); }
  delete(taskId: string):        void { this._tasks.delete(taskId); }
  list():  readonly NopTaskRecord[]   { return [...this._tasks.values()]; }
}

// ── Internal per-node outcome ─────────────────────────────────────────────────

interface NodeOutcome {
  state:        TaskState;   // Completed | Failed | Skipped
  result?:      unknown;
  errorCode?:   string;
  errorMessage?: string;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class NopOrchestrator {
  private readonly worker: INopWorkerClient;
  private readonly opts: Required<Omit<NopOrchestratorOptions, "clusterResolver">> &
    Pick<NopOrchestratorOptions, "clusterResolver">;

  constructor(
    workerOrDispatcher: INopWorkerClient | INopWorkerDispatcher,
    private readonly store: InMemoryNopTaskStore = new InMemoryNopTaskStore(),
    opts: NopOrchestratorOptions = {},
  ) {
    this.worker = isWorkerClient(workerOrDispatcher)
      ? workerOrDispatcher
      : dispatcherToClient(workerOrDispatcher);

    this.opts = {
      defaultTimeoutMs:         opts.defaultTimeoutMs         ?? NopConstants.DefaultTimeoutMs,
      maxTimeoutMs:             opts.maxTimeoutMs             ?? NopConstants.MaxTimeoutMs,
      maxConcurrentNodes:       opts.maxConcurrentNodes       ?? 8,
      validateSenderNid:        opts.validateSenderNid        ?? true,
      enableCallback:           opts.enableCallback           ?? true,
      callbackTimeoutMs:        opts.callbackTimeoutMs        ?? 10_000,
      callbackRetryBaseDelayMs: opts.callbackRetryBaseDelayMs ?? 1000,
      defaultAggregateStrategy: opts.defaultAggregateStrategy ?? "merge",
      clusterResolver:          opts.clusterResolver,
    };
  }

  onAnchorFailover(clusterAnchor: string, successorNid: string, clusterEpoch: number): boolean {
    return this.opts.clusterResolver?.onAnchorFailover(clusterAnchor, successorNid, clusterEpoch) ?? false;
  }

  async execute(task: TaskFrame, signal?: AbortSignal): Promise<NopTaskResult> {
    // 1a. Delegation depth guard.
    if (task.delegateDepth >= NopConstants.MaxDelegateChainDepth)
      return this._failure(task.taskId, NOP_DELEGATE_CHAIN_TOO_DEEP,
        `Delegation chain depth ${task.delegateDepth} exceeds the maximum of ${NopConstants.MaxDelegateChainDepth}.`);

    // 1b. Validate callback_url (MUST https://, SHOULD NOT be private IP).
    if (task.callbackUrl) {
      const urlError = validateCallbackUrl(task.callbackUrl);
      if (urlError) return this._failure(task.taskId, NOP_TASK_DAG_INVALID, urlError);
    }

    // 1c. Validate DAG.
    const validation = validateDag(task.dag);
    if (!validation.valid)
      return this._failure(task.taskId, validation.errorCode!, validation.errorMessage!);

    // 2. Reject already-known tasks.
    if (this.store.get(task.taskId))
      return this._failure(task.taskId, NOP_TASK_ALREADY_COMPLETED, `Task '${task.taskId}' already exists.`);

    // 3. Persist initial record.
    const record: NopTaskRecord = {
      taskId:      task.taskId,
      frame:       task,
      state:       TaskState.PENDING,
      startedAt:   new Date(),
      nodeResults: new Map(),
    };
    this.store.save(record);

    // 4. Timeout = min(task.timeout, MaxTimeoutMs). Linked to caller's AbortSignal.
    const taskTimeoutMs = task.timeoutMs ?? this.opts.defaultTimeoutMs;
    const timeoutMs = Math.min(taskTimeoutMs, this.opts.maxTimeoutMs);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    const onTimeout = () => { if (!signal?.aborted) timedOut = true; };
    controller.signal.addEventListener("abort", onTimeout, { once: true });

    try {
      // 5. Optional preflight.
      if (task.preflight) {
        record.state = TaskState.PREFLIGHT;
        this.store.save(record);
        const preflightFail = await this._runPreflight(task, controller.signal);
        if (preflightFail) {
          record.state = TaskState.FAILED;
          record.completedAt = new Date();
          this.store.save(record);
          return this._failure(task.taskId, NOP_RESOURCE_INSUFFICIENT, preflightFail);
        }
      }

      record.state = TaskState.RUNNING;
      this.store.save(record);

      // 6. Execute DAG.
      const result = await this._runDag(task, record, validation.topologicalOrder!, controller.signal);

      // 7. Finalise state in store.
      record.state = result.state;
      record.error = result.error;
      record.completedAt = new Date();
      this.store.save(record);

      // 8. Fire callback (fire-and-forget).
      if (this.opts.enableCallback && task.callbackUrl)
        void this._fireCallback(task.callbackUrl, task.callbackSecret, result);

      return result;
    } catch (err) {
      // Timeout or external cancellation propagated out of the DAG runner.
      record.completedAt = new Date();
      if (signal?.aborted) {
        record.state = TaskState.CANCELLED;
        this.store.save(record);
        return this._finalize(task, record, undefined, TaskState.CANCELLED,
          { code: NOP_TASK_CANCELLED, message: "Task cancelled." });
      }
      if (timedOut || (err instanceof AbortError)) {
        record.state = TaskState.FAILED;
        this.store.save(record);
        return this._finalize(task, record, undefined, TaskState.FAILED,
          { code: NOP_TASK_TIMEOUT, message: `Task exceeded timeout of ${timeoutMs}ms.` });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  cancel(taskId: string): void {
    const rec = this.store.get(taskId);
    if (rec) { rec.state = TaskState.CANCELLED; this.store.save(rec); }
  }

  getStatus(taskId: string): NopTaskRecord | undefined {
    return this.store.get(taskId);
  }

  // ── DAG execution ───────────────────────────────────────────────────────────

  private async _runDag(
    task:      TaskFrame,
    record:    NopTaskRecord,
    topoOrder: readonly string[],
    signal:    AbortSignal,
  ): Promise<NopTaskResult> {
    const allNodes = new Map<string, DagNode>(task.dag.nodes.map((n) => [n.id, n]));
    const nodeResults = new Map<string, unknown>();          // completed outputs only
    const nodeStates  = new Map<string, TaskState>();        // terminal state per node
    const inFlight    = new Map<string, Promise<{ nodeId: string; outcome: NodeOutcome }>>();

    const hasOutgoing = new Set<string>(task.dag.edges.map((e) => e.from));
    const endNodeIds  = [...allNodes.keys()].filter((id) => !hasOutgoing.has(id));

    while (nodeStates.size < allNodes.size) {
      if (signal.aborted) throw new AbortError();

      // Ready nodes: deps all done, not started.
      const readyNodes = [...allNodes.values()].filter(
        (n) => !nodeStates.has(n.id) && !inFlight.has(n.id) && this._areDepsDone(n, nodeStates),
      );

      // K-of-N feasibility: fail nodes whose K can never be met.
      for (const n of [...readyNodes]) {
        if (!n.inputFrom || n.inputFrom.length === 0) continue;
        const total = n.inputFrom.length;
        const k = (n.minRequired ?? 0) > 0 ? n.minRequired! : total;
        const success = n.inputFrom.filter(
          (d) => { const s = nodeStates.get(d); return s === TaskState.COMPLETED || s === TaskState.SKIPPED; },
        ).length;
        if (success < k) {
          nodeStates.set(n.id, TaskState.FAILED);
          this._recordFail(record, n.id, NOP_SYNC_DEPENDENCY_FAILED,
            `Only ${success}/${k} required dependencies succeeded.`);
          const idx = readyNodes.indexOf(n);
          if (idx >= 0) readyNodes.splice(idx, 1);
        }
      }

      // Launch ready nodes up to MaxConcurrentNodes.
      for (const node of readyNodes) {
        if (inFlight.size >= this.opts.maxConcurrentNodes) break;
        inFlight.set(node.id, this._executeNodeWithRetry(task, node, nodeResults, signal)
          .then((outcome) => ({ nodeId: node.id, outcome })));
      }

      if (inFlight.size === 0) break; // stuck or finished

      // Await next completion.
      const { nodeId, outcome } = await Promise.race(inFlight.values());
      inFlight.delete(nodeId);

      nodeStates.set(nodeId, outcome.state);
      if (outcome.state === TaskState.COMPLETED) {
        nodeResults.set(nodeId, outcome.result);
        record.nodeResults.set(nodeId, { nodeId, ok: true, output: outcome.result });
      } else if (outcome.state === TaskState.SKIPPED) {
        record.nodeResults.set(nodeId, { nodeId, ok: true, skipped: true });
      } else {
        record.nodeResults.set(nodeId, {
          nodeId, ok: false,
          error: { code: outcome.errorCode ?? NOP_DELEGATE_TIMEOUT, message: outcome.errorMessage ?? "" },
        });
      }
      this.store.save(record);

      // Abort only if an end node can no longer satisfy its K.
      if (outcome.state === TaskState.FAILED) {
        const mustAbort = endNodeIds.some(
          (e) => this._canReachEndNode(e, nodeId, task.dag) &&
                 !this._canEndNodeStillSucceed(e, allNodes, nodeStates),
        );
        if (mustAbort) {
          await this._settleInFlight(inFlight);
          const compensation = CompensationPolicy.runsOnFailure(task.compensationPolicy)
            ? await this._runSagaCompensation(task, allNodes, topoOrder, nodeResults, nodeStates, signal)
            : undefined;
          const code = this._compensationFailureErrorCode(task, compensation) ?? NOP_SYNC_DEPENDENCY_FAILED;
          return this._finalize(task, record, undefined, TaskState.FAILED,
            { code, message: `Node '${nodeId}' failed: ${outcome.errorCode}` }, compensation);
        }
      }
    }

    // All nodes done — did any end node fail?
    const anyEndFailed = endNodeIds.some((e) => nodeStates.get(e) === TaskState.FAILED);
    if (anyEndFailed) {
      const failedEnds = endNodeIds.filter((e) => nodeStates.get(e) === TaskState.FAILED);
      const compensation = CompensationPolicy.runsOnFailure(task.compensationPolicy)
        ? await this._runSagaCompensation(task, allNodes, topoOrder, nodeResults, nodeStates, signal)
        : undefined;
      const code = this._compensationFailureErrorCode(task, compensation) ?? NOP_SYNC_DEPENDENCY_FAILED;
      return this._finalize(task, record, undefined, TaskState.FAILED,
        { code, message: `End node(s) failed: ${failedEnds.join(", ")}` }, compensation);
    }

    // Aggregate end-node results.
    const aggregated = aggregateEndNodes(endNodeIds, nodeResults, this.opts.defaultAggregateStrategy);

    const successCompensation = CompensationPolicy.runsOnSuccess(task.compensationPolicy)
      ? await this._runSagaCompensation(task, allNodes, topoOrder, nodeResults, nodeStates, signal)
      : undefined;

    return this._finalize(task, record, aggregated, TaskState.COMPLETED, undefined, successCompensation);
  }

  // ── Node execution + retry ────────────────────────────────────────────────

  private async _executeNodeWithRetry(
    task:    TaskFrame,
    node:    DagNode,
    context: ReadonlyMap<string, unknown>,
    signal:  AbortSignal,
  ): Promise<NodeOutcome> {
    const idempotencyKey = randomId(); // stable across retries
    const subtaskId = randomId();
    const maxRetries = node.retryPolicy?.maxRetries ?? task.maxRetries;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (signal.aborted) throw new AbortError();

      // Evaluate condition once (before first attempt).
      if (attempt === 1 && node.condition) {
        try {
          if (!evaluateCondition(node.condition, context)) {
            return { state: TaskState.SKIPPED };
          }
        } catch (err) {
          if (err instanceof NopConditionError)
            return { state: TaskState.FAILED, errorCode: NOP_CONDITION_EVAL_ERROR, errorMessage: err.message };
          throw err;
        }
      }

      const outcome = await this._executeNodeOnce(task, node, subtaskId, idempotencyKey, context, signal);
      if (outcome.state === TaskState.COMPLETED) return outcome;

      const retriable = shouldRetry(node.retryPolicy?.retryOn, outcome.errorCode, attempt, maxRetries);
      if (!retriable) return outcome;

      const delayMs = computeBackoffMs(node.retryPolicy, attempt - 1);
      if (delayMs > 0) await delay(delayMs, signal);
    }

    return {
      state: TaskState.FAILED,
      errorCode: NOP_DELEGATE_TIMEOUT,
      errorMessage: `Node '${node.id}' exhausted ${maxRetries} retries.`,
    };
  }

  private async _executeNodeOnce(
    task:           TaskFrame,
    node:           DagNode,
    subtaskId:      string,
    idempotencyKey: string,
    context:        ReadonlyMap<string, unknown>,
    signal:         AbortSignal,
  ): Promise<NodeOutcome> {
    // Resolve input_mapping → params.
    let params: Record<string, unknown>;
    try {
      params = buildParams(node.inputMapping as Record<string, unknown> | undefined, context);
    } catch (err) {
      if (err instanceof NopMappingError)
        return { state: TaskState.FAILED, errorCode: err.errorCode, errorMessage: err.message };
      throw err;
    }

    // If no explicit mapping, pass through upstream outputs (backward-compatible behaviour).
    let resolvedParams: unknown = params;
    if (!node.inputMapping || Object.keys(node.inputMapping).length === 0) {
      const upstream = node.inputFrom ?? [];
      if (upstream.length === 0) resolvedParams = undefined;
      else if (upstream.length === 1) resolvedParams = context.get(upstream[0]);
      else {
        const passthrough: Record<string, unknown> = {};
        for (const dep of upstream) passthrough[dep] = context.get(dep);
        resolvedParams = passthrough;
      }
    }

    const nodeTimeoutMs = Math.min(node.timeoutMs ?? task.timeoutMs ?? this.opts.defaultTimeoutMs,
      this.opts.maxTimeoutMs);
    const deadlineAt = new Date(Date.now() + nodeTimeoutMs).toISOString();

    const frame = new DelegateFrame(
      task.taskId, subtaskId, node.action, node.agent,
      undefined,
      (resolvedParams != null && typeof resolvedParams === "object" && !Array.isArray(resolvedParams))
        ? (resolvedParams as Record<string, unknown>) : { value: resolvedParams },
      idempotencyKey, node.targetClusterAnchor,
      node.id, deadlineAt, task.priority, task.delegateDepth + 1, task.context,
    );
    // Preserve the exact resolved params object for the passthrough dispatcher path.
    (frame as unknown as { resolvedParams: unknown }).resolvedParams = resolvedParams;
    (frame as unknown as { resolvedTargetNid: string }).resolvedTargetNid = await this._resolveTarget(node);

    // Node-level timeout linked to the task signal.
    const nodeController = new AbortController();
    const onAbort = () => nodeController.abort();
    if (signal.aborted) nodeController.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const nodeTimer = setTimeout(() => nodeController.abort(), nodeTimeoutMs);

    try {
      let finalResult: unknown;
      let errorCode: string | undefined;
      let errorMsg: string | undefined;
      let lastSeq = 0;
      let gotFinal = false;

      for await (const f of this.worker.delegate(frame, nodeController.signal)) {
        // Sequence gap check.
        if (f.seq !== lastSeq && f.seq !== 0) {
          if (f.seq !== lastSeq + 1)
            return { state: TaskState.FAILED, errorCode: NOP_STREAM_SEQ_GAP };
        }
        lastSeq = f.seq;

        // Sender NID validation.
        if (this.opts.validateSenderNid && f.senderNid && f.senderNid !== node.agent)
          return { state: TaskState.FAILED, errorCode: NOP_STREAM_NID_MISMATCH };

        if (f.isFinal) {
          gotFinal = true;
          if (f.error) { errorCode = f.error.errorCode; errorMsg = f.error.message; }
          else finalResult = f.data;
          break;
        }
      }

      if (!gotFinal)
        return { state: TaskState.FAILED, errorCode: NOP_DELEGATE_TIMEOUT, errorMessage: "Stream ended without final frame." };
      if (errorCode) {
        if (node.targetClusterAnchor && errorCode === NWP_ANCHOR_NOT_LEADER) {
          this.opts.clusterResolver?.invalidate(node.targetClusterAnchor);
        }
        return { state: TaskState.FAILED, errorCode, errorMessage: errorMsg };
      }
      return { state: TaskState.COMPLETED, result: finalResult };
    } catch (err) {
      if (signal.aborted) throw new AbortError();
      if (err instanceof AbortError || nodeController.signal.aborted)
        return { state: TaskState.FAILED, errorCode: NOP_DELEGATE_TIMEOUT, errorMessage: `Node '${node.id}' timed out after ${nodeTimeoutMs}ms.` };
      throw err;
    } finally {
      clearTimeout(nodeTimer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // ── K-of-N helpers ──────────────────────────────────────────────────────────

  private _areDepsDone(node: DagNode, states: ReadonlyMap<string, TaskState>): boolean {
    if (!node.inputFrom || node.inputFrom.length === 0) return true;
    const total = node.inputFrom.length;
    const k = (node.minRequired ?? 0) > 0 ? node.minRequired! : total;
    const success = node.inputFrom.filter(
      (d) => { const s = states.get(d); return s === TaskState.COMPLETED || s === TaskState.SKIPPED; },
    ).length;
    const failed = node.inputFrom.filter((d) => states.get(d) === TaskState.FAILED).length;
    if (success >= k) return true;       // K already satisfied
    if (total - failed < k) return true; // impossible to satisfy K
    return false;                        // still waiting
  }

  private _canEndNodeStillSucceed(
    endNodeId: string,
    allNodes:  ReadonlyMap<string, DagNode>,
    states:    ReadonlyMap<string, TaskState>,
  ): boolean {
    const node = allNodes.get(endNodeId)!;
    if (!node.inputFrom || node.inputFrom.length === 0) return false; // reachable but no deps → can't recover
    const total = node.inputFrom.length;
    const k = (node.minRequired ?? 0) > 0 ? node.minRequired! : total;
    const failed = node.inputFrom.filter((d) => states.get(d) === TaskState.FAILED).length;
    return total - failed >= k; // optimistic
  }

  private _canReachEndNode(endNodeId: string, fromNodeId: string, dag: TaskDag): boolean {
    const adj = new Map<string, string[]>();
    for (const e of dag.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from)!.push(e.to);
    }
    const seen = new Set<string>();
    const queue = [fromNodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === endNodeId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of adj.get(cur) ?? []) queue.push(n);
    }
    return false;
  }

  private async _settleInFlight(
    inFlight: Map<string, Promise<{ nodeId: string; outcome: NodeOutcome }>>,
  ): Promise<void> {
    try { await Promise.allSettled(inFlight.values()); } catch { /* ignore */ }
    inFlight.clear();
  }

  // ── Preflight ─────────────────────────────────────────────────────────────

  private async _runPreflight(task: TaskFrame, signal: AbortSignal): Promise<string | null> {
    // Deduplicate by agent NID (one probe per unique agent).
    const byAgent = new Map<string, string[]>();
    for (const n of task.dag.nodes) {
      if (!byAgent.has(n.agent)) byAgent.set(n.agent, []);
      if (!byAgent.get(n.agent)!.includes(n.action)) byAgent.get(n.agent)!.push(n.action);
    }

    let results: PreflightResult[];
    try {
      results = await Promise.all(
        [...byAgent.entries()].map(([agent, actions]) =>
          this.worker.preflight(agent, actions[0], { signal })),
      );
    } catch (err) {
      return `Preflight probe failed: ${(err as Error).message}`;
    }

    const unavailable = results.find((r) => !r.available);
    if (unavailable)
      return `Agent '${unavailable.agentNid}' is unavailable: ${unavailable.unavailableReason ?? "no reason given"}`;
    return null;
  }

  // ── Saga compensation ───────────────────────────────────────────────────────

  private async _runSagaCompensation(
    task:        TaskFrame,
    allNodes:    ReadonlyMap<string, DagNode>,
    topoOrder:   readonly string[],
    nodeResults: ReadonlyMap<string, unknown>,
    nodeStates:  ReadonlyMap<string, TaskState>,
    signal:      AbortSignal,
  ): Promise<SagaCompensationResult> {
    // Completed nodes in reverse topo order.
    const completed = [...topoOrder]
      .filter((id) => nodeStates.get(id) === TaskState.COMPLETED && allNodes.has(id))
      .reverse();

    if (CompensationPolicy.isStrict(task.compensationPolicy)) {
      const missing = completed.filter((id) => !allNodes.get(id)!.compensate_action);
      if (missing.length > 0)
        return { attempted: 0, succeeded: 0, failed: missing.length, failedNodeIds: missing };
    }

    const toCompensate = completed.filter((id) => allNodes.get(id)!.compensate_action);
    if (toCompensate.length === 0)
      return { attempted: 0, succeeded: 0, failed: 0, failedNodeIds: [] };

    let succeeded = 0;
    const failedIds: string[] = [];

    for (const nodeId of toCompensate) {
      const node = allNodes.get(nodeId)!;
      const compensationNode: DagNode = {
        ...node,
        action: node.compensate_action!,
        inputMapping: node.compensate_params_mapping as Record<string, string> | undefined,
        condition: undefined,
        retryPolicy: undefined,
      };

      const outcome = await this._executeNodeOnce(
        task, compensationNode, randomId(), randomId(), nodeResults, signal,
      );
      if (outcome.state === TaskState.COMPLETED) succeeded++;
      else failedIds.push(nodeId);
    }

    return { attempted: toCompensate.length, succeeded, failed: failedIds.length, failedNodeIds: failedIds };
  }

  private _compensationFailureErrorCode(
    task: TaskFrame,
    compensation: SagaCompensationResult | undefined,
  ): string | null {
    if (!CompensationPolicy.isStrict(task.compensationPolicy) || !compensation || compensation.failed === 0)
      return null;
    return compensation.attempted === 0 ? NOP_COMPENSATION_NOT_SUPPORTED : NOP_COMPENSATION_FAILED;
  }

  // ── Callback ────────────────────────────────────────────────────────────────

  private async _fireCallback(
    callbackUrl:    string,
    callbackSecret: string | undefined,
    result:         NopTaskResult,
  ): Promise<void> {
    const payload = JSON.stringify(serializeResult(result));
    const signature = await buildCallbackSignature(callbackSecret, payload);

    for (let attempt = 1; attempt <= NopConstants.CallbackMaxRetries; attempt++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), this.opts.callbackTimeoutMs);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (signature) headers["X-NPS-Signature"] = signature;
        try {
          const res = await fetch(callbackUrl, { method: "POST", body: payload, headers, signal: ctl.signal });
          if (res.ok) return;
        } finally {
          clearTimeout(t);
        }
      } catch { /* non-fatal */ }

      if (attempt < NopConstants.CallbackMaxRetries && this.opts.callbackRetryBaseDelayMs > 0) {
        const d = this.opts.callbackRetryBaseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, d));
      }
    }
    // Gave up — non-fatal.
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private _recordFail(record: NopTaskRecord, nodeId: string, code: string, message: string): void {
    record.nodeResults.set(nodeId, { nodeId, ok: false, error: { code, message } });
    this.store.save(record);
  }

  private _finalize(
    task:         TaskFrame,
    record:       NopTaskRecord,
    aggregated:   unknown,
    state:        TaskState,
    error?:       { code: string; message: string },
    compensation?: SagaCompensationResult,
  ): NopTaskResult {
    record.state = state;
    record.error = error;
    this.store.save(record);
    return {
      taskId:           task.taskId,
      state,
      aggregatedResult: state === TaskState.COMPLETED ? aggregated : undefined,
      nodeResults:      mapToRecord(record.nodeResults),
      error,
      compensation,
    };
  }

  private _failure(taskId: string, code: string, message: string): NopTaskResult {
    return { taskId, state: TaskState.FAILED, nodeResults: {}, error: { code, message } };
  }

  private async _resolveTarget(node: DagNode): Promise<string> {
    const cluster = node.targetClusterAnchor;
    const resolver = this.opts.clusterResolver;
    if (!cluster || !resolver) return node.agent;
    const info = await resolver.resolveActive(cluster);
    return info?.activeNid ?? node.agent;
  }
}

// ── Module-level helpers ────────────────────────────────────────────────────

class AbortError extends Error {
  constructor() { super("Aborted"); this.name = "AbortError"; }
}

function isWorkerClient(x: INopWorkerClient | INopWorkerDispatcher): x is INopWorkerClient {
  return typeof (x as INopWorkerClient).delegate === "function";
}

/**
 * Adapts a single-call {@link INopWorkerDispatcher} to the streaming
 * {@link INopWorkerClient} contract used internally by the engine.
 */
function dispatcherToClient(dispatcher: INopWorkerDispatcher): INopWorkerClient {
  return {
    async *delegate(frame: DelegateFrame): AsyncIterable<import("./frames.js").AlignStreamFrame> {
      const nodeId = frame.nodeId ?? frame.subtaskId;
      // Recover the exact resolved params captured by the engine.
      const params = (frame as unknown as { resolvedParams?: unknown }).resolvedParams;
      const deadlineMs = frame.deadlineAt ? Math.max(0, Date.parse(frame.deadlineAt) - Date.now()) : 0;
      // The dispatcher receives the DagNode via a light shim carrying id/action/agent.
      const nodeShim = { id: nodeId, action: frame.action, agent: frame.agentNid } as unknown as DagNode;
      const targetNid = (frame as unknown as { resolvedTargetNid?: string }).resolvedTargetNid ?? frame.agentNid;
      const r = await dispatcher.dispatch(nodeId, nodeShim, params, deadlineMs, targetNid);
      const { AlignStreamFrame } = await import("./frames.js");
      yield new AlignStreamFrame(
        randomId(), frame.taskId, frame.subtaskId, 0, true, frame.agentNid,
        r.ok ? (r.output as Record<string, unknown> | undefined) : undefined,
        r.ok ? undefined : { errorCode: r.error?.code ?? NOP_DELEGATE_TIMEOUT, message: r.error?.message },
      );
    },
    async preflight(agentNid: string): Promise<PreflightResult> {
      return { agentNid, available: true };
    },
  };
}

function shouldRetry(
  retryOn: readonly string[] | undefined,
  errorCode: string | undefined,
  attempt: number,
  maxRetries: number,
): boolean {
  if (attempt > maxRetries) return false;
  if (retryOn && retryOn.length > 0 && errorCode) return retryOn.includes(errorCode);
  return true;
}

function computeBackoffMs(
  policy: { backoff?: string; baseDelayMs?: number; maxDelayMs?: number } | undefined,
  attempt: number,
): number {
  const base = policy?.baseDelayMs ?? 1000;
  const cap = policy?.maxDelayMs ?? 30_000;
  let d: number;
  switch (policy?.backoff) {
    case "fixed":  d = base; break;
    case "linear": d = base * (attempt + 1); break;
    default:       d = base * Math.pow(2, attempt); // exponential
  }
  return Math.min(d, cap);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new AbortError()); };
    const cleanup = () => { clearTimeout(t); signal.removeEventListener("abort", onAbort); };
    if (signal.aborted) { cleanup(); reject(new AbortError()); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function mapToRecord(m: ReadonlyMap<string, NodeResult>): Record<string, NodeResult> {
  const out: Record<string, NodeResult> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

/** Serializes NopTaskResult to snake_case wire shape for callbacks (mirrors .NET). */
function serializeResult(result: NopTaskResult): Record<string, unknown> {
  const nodeResults: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result.nodeResults)) {
    if (v.ok && v.output !== undefined) nodeResults[k] = v.output;
  }
  return {
    task_id:           result.taskId,
    final_state:       result.state,
    aggregated_result: result.aggregatedResult ?? null,
    error_code:        result.error?.code ?? null,
    error_message:     result.error?.message ?? null,
    node_results:      nodeResults,
    compensation:      result.compensation
      ? {
          attempted:       result.compensation.attempted,
          succeeded:       result.compensation.succeeded,
          failed:          result.compensation.failed,
          failed_node_ids: result.compensation.failedNodeIds,
        }
      : null,
  };
}

/**
 * Builds the `X-NPS-Signature: sha256=<lowerhex>` header value using HMAC-SHA256
 * when `callbackSecret` is a base64url-encoded 32-byte key. Returns null otherwise.
 */
export async function buildCallbackSignature(
  callbackSecret: string | undefined,
  payload: string,
): Promise<string | null> {
  if (!callbackSecret || callbackSecret.trim().length === 0) return null;
  const key = tryDecodeBase64Url(callbackSecret);
  if (!key || key.length !== 32) return null;

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw", toArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const msg = toArrayBuffer(new TextEncoder().encode(payload));
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, msg));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

/** Copies a Uint8Array into a fresh, plain ArrayBuffer (avoids SharedArrayBuffer typing). */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

function tryDecodeBase64Url(value: string): Uint8Array | null {
  try {
    let s = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4 !== 0) s += "=";
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
