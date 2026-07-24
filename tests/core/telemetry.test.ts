// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Telemetry abstraction tests: counters, histograms, spans, in-memory readers,
// plus the NWP / NOP instrument-name parity checks.

import { describe, it, expect, afterEach } from "vitest";
import {
  Meter,
  ActivitySource,
  InMemoryMetricsReader,
  InMemorySpanExporter,
} from "../../src/core/telemetry.js";
import { NwpInstrumentation, NwpTelemetry } from "../../src/nwp/telemetry.js";
import { NopInstrumentation, NopTelemetry } from "../../src/nop/telemetry.js";

describe("Meter — counters & histograms", () => {
  it("counter is a no-op until a reader is attached", () => {
    const meter = new Meter("test");
    const c = meter.createCounter("t.count", "{n}", "test counter");
    c.add(1); // no reader → dropped
    const reader = new InMemoryMetricsReader();
    meter.addReader(reader);
    c.add(2, { op: "x" });
    expect(reader.sum("t.count")).toBe(2);
    expect(reader.count("t.count")).toBe(1);
  });

  it("counter accumulates with attribute filtering", () => {
    const meter = new Meter("test");
    const reader = new InMemoryMetricsReader();
    meter.addReader(reader);
    const c = meter.createCounter("errors");
    c.add(1, { code: "A" });
    c.add(1, { code: "A" });
    c.add(1, { code: "B" });
    expect(reader.sum("errors")).toBe(3);
    expect(reader.sum("errors", { code: "A" })).toBe(2);
    expect(reader.sum("errors", { code: "B" })).toBe(1);
  });

  it("histogram records observations", () => {
    const meter = new Meter("test");
    const reader = new InMemoryMetricsReader();
    meter.addReader(reader);
    const h = meter.createHistogram("dur.ms", "ms");
    h.record(10);
    h.record(30);
    expect(reader.count("dur.ms")).toBe(2);
    expect(reader.sum("dur.ms")).toBe(40);
  });

  it("removeReader stops emissions", () => {
    const meter = new Meter("test");
    const reader = new InMemoryMetricsReader();
    meter.addReader(reader);
    const c = meter.createCounter("x");
    c.add(1);
    meter.removeReader(reader);
    c.add(1);
    expect(reader.sum("x")).toBe(1);
  });
});

describe("ActivitySource — spans", () => {
  it("exports a finished span with duration and status", async () => {
    const src = new ActivitySource("test");
    const exp = new InMemorySpanExporter();
    src.addExporter(exp);
    await src.withSpan("op", (span) => {
      span.setAttribute("k", "v");
    });
    expect(exp.spans).toHaveLength(1);
    expect(exp.spans[0]!.name).toBe("op");
    expect(exp.spans[0]!.status).toBe("ok");
    expect(exp.spans[0]!.attributes["k"]).toBe("v");
    expect(exp.spans[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records error status and rethrows", async () => {
    const src = new ActivitySource("test");
    const exp = new InMemorySpanExporter();
    src.addExporter(exp);
    await expect(
      src.withSpan("boom", () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    expect(exp.spans[0]!.status).toBe("error");
    expect(exp.spans[0]!.attributes["error.message"]).toBe("kaboom");
  });

  it("child spans share the parent trace id", () => {
    const src = new ActivitySource("test");
    const exp = new InMemorySpanExporter();
    src.addExporter(exp);
    const parent = src.startSpan("parent");
    const child = src.startSpan("child", parent);
    child.end();
    parent.end();
    expect(exp.spans[0]!.traceId).toBe(exp.spans[1]!.traceId);
    expect(exp.spans[0]!.parentSpanId).toBe(exp.spans[1]!.spanId);
  });

  it("span never exported without an exporter", () => {
    const src = new ActivitySource("test");
    const span = src.startSpan("x");
    expect(() => span.end()).not.toThrow();
  });
});

describe("NWP telemetry — .NET name parity", () => {
  const reader = new InMemoryMetricsReader();
  NwpTelemetry.meter.addReader(reader);
  afterEach(() => reader.clear());

  it("exposes the exact meter/source names", () => {
    expect(NwpInstrumentation.ActivitySourceName).toBe("nps.nwp");
    expect(NwpInstrumentation.MeterName).toBe("nps.nwp");
  });

  it("records the four NWP instruments by name", () => {
    NwpTelemetry.framesProcessed.add(1);
    NwpTelemetry.frameDurationMs.record(12);
    NwpTelemetry.cgnConsumed.add(50);
    NwpTelemetry.frameErrors.add(1);
    expect(reader.sum("nps.frames.processed")).toBe(1);
    expect(reader.sum("nps.frames.processing_ms")).toBe(12);
    expect(reader.sum("nps.cgn.consumed")).toBe(50);
    expect(reader.sum("nps.frames.errors")).toBe(1);
  });
});

describe("NOP telemetry — .NET name parity", () => {
  const reader = new InMemoryMetricsReader();
  NopTelemetry.meter.addReader(reader);
  afterEach(() => reader.clear());

  it("exposes the exact meter/source names", () => {
    expect(NopInstrumentation.ActivitySourceName).toBe("nps.nop");
    expect(NopInstrumentation.MeterName).toBe("nps.nop");
  });

  it("records the five NOP instruments by name", () => {
    NopTelemetry.taskDurationMs.record(100);
    NopTelemetry.nodeDurationMs.record(40);
    NopTelemetry.nodeRetries.add(2);
    NopTelemetry.tasksCompleted.add(1);
    NopTelemetry.tasksFailed.add(1);
    expect(reader.sum("nps.nop.task.duration_ms")).toBe(100);
    expect(reader.sum("nps.nop.node.duration_ms")).toBe(40);
    expect(reader.sum("nps.nop.node.retries")).toBe(2);
    expect(reader.sum("nps.nop.tasks.completed")).toBe(1);
    expect(reader.sum("nps.nop.tasks.failed")).toBe(1);
  });
});
