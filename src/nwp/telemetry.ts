// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// ActivitySource + Meter for NWP frame processing instrumentation. Port of the
// .NET `NwpInstrumentation` (public names) + `NwpTelemetry` (instruments).
// Metric names, meter/source names, and units match the .NET reference exactly.
//
// Instruments are no-ops until a reader/exporter is attached to `nwpMeter` /
// `nwpActivitySource`.

import { ActivitySource, Meter } from "../core/telemetry.js";

/** Public instrument-name constants for the NWP layer. */
export const NwpInstrumentation = {
  /** ActivitySource name for NWP frame processing spans. */
  ActivitySourceName: "nps.nwp",
  /** Meter name for NWP frame metrics. */
  MeterName: "nps.nwp",
  Version: "1.0.0",
} as const;

export const nwpActivitySource = new ActivitySource(
  NwpInstrumentation.ActivitySourceName,
  NwpInstrumentation.Version,
);

export const nwpMeter = new Meter(NwpInstrumentation.MeterName, NwpInstrumentation.Version);

/** Instruments for NWP frame processing. Names/units match .NET `NwpTelemetry`. */
export const NwpTelemetry = {
  source: nwpActivitySource,
  meter: nwpMeter,

  /** Total NWP frames processed. */
  framesProcessed: nwpMeter.createCounter("nps.frames.processed", "{frames}", "Total NWP frames processed"),
  /** NWP frame processing duration. */
  frameDurationMs: nwpMeter.createHistogram("nps.frames.processing_ms", "ms", "NWP frame processing duration"),
  /** CGN units consumed in NWP responses. */
  cgnConsumed: nwpMeter.createCounter("nps.cgn.consumed", "{cgn}", "CGN units consumed in NWP responses"),
  /** NWP frames that returned an error response. */
  frameErrors: nwpMeter.createCounter("nps.frames.errors", "{frames}", "NWP frames that returned an error response"),
} as const;
