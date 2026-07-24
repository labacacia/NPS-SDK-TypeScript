// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Abstraction for dispatching DelegateFrames to Worker Agents and receiving
// AlignStreamFrame results (NPS-5 §3.2, §3.4). TypeScript port of
// NPS.NOP.Orchestration.INopWorkerClient / PreflightResult / SagaCompensationResult.

import type { AlignStreamFrame, DelegateFrame } from "./frames.js";

/**
 * Connects the orchestrator to real (or mock) Worker Agents.
 * Implement `delegate` (streaming) and `preflight`.
 */
export interface INopWorkerClient {
  /**
   * Dispatches a DelegateFrame to the target Worker Agent and yields a stream of
   * AlignStreamFrame messages. The final frame has `isFinal === true`.
   */
  delegate(frame: DelegateFrame, signal?: AbortSignal): AsyncIterable<AlignStreamFrame>;

  /**
   * Sends a lightweight preflight probe to `agentNid` to confirm resource
   * availability before committing to full execution (NPS-5 §4).
   */
  preflight(
    agentNid: string,
    action: string,
    options?: {
      estimatedNpt?: number;
      requiredCapabilities?: readonly string[];
      signal?: AbortSignal;
    },
  ): Promise<PreflightResult>;
}

/** Result returned by a Worker Agent in response to a preflight probe (NPS-5 §4.3). */
export interface PreflightResult {
  /** NID of the responding Worker Agent. */
  agentNid: string;
  /** True when the agent can accept the delegated workload. */
  available: boolean;
  /** CGN budget the agent can commit. Undefined when unavailable. */
  availableCgn?: number;
  /** Estimated queue depth in milliseconds. Undefined when unavailable. */
  estimatedQueueMs?: number;
  /** Capability identifiers the agent supports. */
  capabilities?: readonly string[];
  /** Human-readable reason when `available` is false. */
  unavailableReason?: string;
}

/**
 * Summary of the Saga compensation run (NPS-5 §3.5). Attached to
 * `NopTaskResult.compensation` when rollback was attempted.
 */
export interface SagaCompensationResult {
  attempted: number;
  succeeded: number;
  failed: number;
  failedNodeIds: readonly string[];
}
