// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

export enum TaskState {
  PENDING       = "pending",
  PREFLIGHT     = "preflight",
  RUNNING       = "running",
  WAITING_SYNC  = "waiting_sync",
  COMPLETED     = "completed",
  FAILED        = "failed",
  CANCELLED     = "cancelled",
  SKIPPED       = "skipped",
  COMPENSATING  = "compensating",
  COMPENSATED   = "compensated",
}

export enum TaskPriority {
  LOW    = "low",
  NORMAL = "normal",
  HIGH   = "high",
}

export enum BackoffStrategy {
  FIXED       = "fixed",
  LINEAR      = "linear",
  EXPONENTIAL = "exponential",
}

export enum AggregateStrategy {
  MERGE            = "merge",
  FIRST            = "first",
  FASTEST_K        = "fastest_k",
  ALL              = "all",
  WEIGHTED_FIRST_K = "weighted_first_k",
  MERGE_ALL        = "merge_all",
}

export interface RetryPolicy {
  maxRetries:   number;
  backoff:      BackoffStrategy;
  baseDelayMs?: number;
  maxDelayMs?:  number;
  /** Error codes that trigger retry. Omitted/empty means retry on all failures (NPS-5 §3.1.4). */
  retryOn?:     readonly string[];
}

export function computeDelayMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.baseDelayMs ?? 1000;
  const cap  = policy.maxDelayMs  ?? 30_000;
  let delay: number;
  switch (policy.backoff) {
    case BackoffStrategy.FIXED:       delay = base; break;
    case BackoffStrategy.LINEAR:      delay = base * (attempt + 1); break;
    case BackoffStrategy.EXPONENTIAL: delay = base * Math.pow(2, attempt); break;
  }
  return Math.min(delay, cap);
}

export interface TaskContext {
  sessionKey?:    string;
  requesterNid?:  string;
  traceId?:       string;
}

/**
 * Valid values and predicates for `TaskFrame.compensation_policy` (NPS-5 §3.5).
 * Mirrors NPS.NOP.Models.CompensationPolicy.
 */
export const CompensationPolicy = {
  /** Run compensation for completed predecessors on failure; failures are non-terminal. */
  BEST_EFFORT: 'best_effort',
  /** Run compensation on failure; missing or failed compensation is terminal. */
  STRICT:      'strict',
  /** Legacy alias: no saga rollback. Not an NPS-5 wire value. */
  NONE:        'none',
  /** Legacy alias for BEST_EFFORT. */
  ON_FAILURE:  'on_failure',
  /** Non-standard extension: compensate after both success and failure. */
  ALWAYS:      'always',

  /** True when the policy runs compensation after a task failure. */
  runsOnFailure(policy: string | undefined | null): boolean {
    return policy === CompensationPolicy.BEST_EFFORT
      || policy === CompensationPolicy.STRICT
      || policy === CompensationPolicy.ON_FAILURE
      || policy === CompensationPolicy.ALWAYS;
  },
  /** True when the policy runs compensation after a successful task. */
  runsOnSuccess(policy: string | undefined | null): boolean {
    return policy === CompensationPolicy.ALWAYS;
  },
  /** True when any missing or failed compensation step is terminal. */
  isStrict(policy: string | undefined | null): boolean {
    return policy === CompensationPolicy.STRICT;
  },
} as const;

export interface DagNode {
  id:             string;
  action:         string;
  agent:          string;
  inputFrom?:     readonly string[];
  inputMapping?:  Record<string, string>;
  timeoutMs?:                  number;
  retryPolicy?:                RetryPolicy;
  condition?:                  string;
  minRequired?:                number;
  compensate_action?:          string;
  compensate_params_mapping?:  Record<string, unknown>;
}

export interface DagEdge {
  from: string;
  to:   string;
}

export interface TaskDag {
  nodes: readonly DagNode[];
  edges: readonly DagEdge[];
}
