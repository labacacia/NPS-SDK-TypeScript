// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// ActivitySource + Meter for NOP orchestration instrumentation. Port of the
// .NET `NopInstrumentation` (public names) + `NopTelemetry` (instruments).
// Metric names, meter/source names, and units match the .NET reference exactly.

import { ActivitySource, Meter } from "../core/telemetry.js";

/** Public instrument-name constants for the NOP layer. */
export const NopInstrumentation = {
  /** ActivitySource name for NOP orchestration spans. */
  ActivitySourceName: "nps.nop",
  /** Meter name for NOP orchestration metrics. */
  MeterName: "nps.nop",
  Version: "1.0.0",
} as const;

export const nopActivitySource = new ActivitySource(
  NopInstrumentation.ActivitySourceName,
  NopInstrumentation.Version,
);

export const nopMeter = new Meter(NopInstrumentation.MeterName, NopInstrumentation.Version);

/** Instruments for NOP orchestration. Names/units match .NET `NopTelemetry`. */
export const NopTelemetry = {
  source: nopActivitySource,
  meter: nopMeter,

  /** NOP task total execution duration. */
  taskDurationMs: nopMeter.createHistogram("nps.nop.task.duration_ms", "ms", "NOP task total execution duration"),
  /** NOP DAG node execution duration. */
  nodeDurationMs: nopMeter.createHistogram("nps.nop.node.duration_ms", "ms", "NOP DAG node execution duration"),
  /** NOP DAG node retry attempts. */
  nodeRetries: nopMeter.createCounter("nps.nop.node.retries", "{retries}", "NOP DAG node retry attempts"),
  /** NOP tasks completed successfully. */
  tasksCompleted: nopMeter.createCounter("nps.nop.tasks.completed", "{tasks}", "NOP tasks completed successfully"),
  /** NOP tasks that failed or timed out. */
  tasksFailed: nopMeter.createCounter("nps.nop.tasks.failed", "{tasks}", "NOP tasks that failed or timed out"),
} as const;
