// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Dependency-free metrics + tracing abstraction. Mirrors the shape of the .NET
// `System.Diagnostics.Metrics` (Meter / Counter / Histogram) and
// `System.Diagnostics` (ActivitySource / Activity) instrumentation used by
// `NwpTelemetry` / `NopTelemetry`, without pulling in OpenTelemetry.
//
// Instruments are cheap no-ops until a reader/listener is attached, matching
// the .NET "no-op when no listener is subscribed" contract. Tests attach an
// `InMemoryMetricsReader` / `InMemorySpanExporter` to observe emissions.

export type Attributes = Record<string, string | number | boolean>;

// ── Metrics ────────────────────────────────────────────────────────────────

/** A recorded counter increment (or histogram observation) for readers. */
export interface MetricMeasurement {
  meter: string;
  instrument: string;
  value: number;
  unit: string;
  attributes: Attributes;
}

/** Sink for metric measurements. Attach to a Meter to observe emissions. */
export interface MetricsReader {
  onMeasurement(m: MetricMeasurement): void;
}

/** Collects every measurement in memory for assertions in tests. */
export class InMemoryMetricsReader implements MetricsReader {
  readonly measurements: MetricMeasurement[] = [];

  onMeasurement(m: MetricMeasurement): void {
    this.measurements.push(m);
  }

  /** Sum of all values recorded for `instrument` (optionally filtered by attrs). */
  sum(instrument: string, where?: Partial<Attributes>): number {
    return this.forInstrument(instrument, where).reduce((a, m) => a + m.value, 0);
  }

  /** Number of measurements recorded for `instrument`. */
  count(instrument: string, where?: Partial<Attributes>): number {
    return this.forInstrument(instrument, where).length;
  }

  /** All measurements for `instrument` (optionally filtered by attrs). */
  forInstrument(instrument: string, where?: Partial<Attributes>): MetricMeasurement[] {
    return this.measurements.filter(
      (m) => m.instrument === instrument && matches(m.attributes, where),
    );
  }

  clear(): void {
    this.measurements.length = 0;
  }
}

/** Monotonic counter instrument. */
export class Counter {
  constructor(
    private readonly meter: Meter,
    readonly name: string,
    readonly unit: string,
    readonly description: string,
  ) {}

  add(value: number, attributes: Attributes = {}): void {
    this.meter._emit({ meter: this.meter.name, instrument: this.name, value, unit: this.unit, attributes });
  }
}

/** Value-distribution instrument. */
export class Histogram {
  constructor(
    private readonly meter: Meter,
    readonly name: string,
    readonly unit: string,
    readonly description: string,
  ) {}

  record(value: number, attributes: Attributes = {}): void {
    this.meter._emit({ meter: this.meter.name, instrument: this.name, value, unit: this.unit, attributes });
  }
}

/**
 * A named group of instruments. Readers can be attached process-wide (mirrors
 * how OTEL listeners subscribe to a Meter by name).
 */
export class Meter {
  private readonly readers = new Set<MetricsReader>();

  constructor(readonly name: string, readonly version: string = "1.0.0") {}

  createCounter(name: string, unit = "", description = ""): Counter {
    return new Counter(this, name, unit, description);
  }

  createHistogram(name: string, unit = "", description = ""): Histogram {
    return new Histogram(this, name, unit, description);
  }

  addReader(reader: MetricsReader): void {
    this.readers.add(reader);
  }

  removeReader(reader: MetricsReader): void {
    this.readers.delete(reader);
  }

  /** @internal */
  _emit(m: MetricMeasurement): void {
    if (this.readers.size === 0) return; // no-op fast path
    for (const r of this.readers) r.onMeasurement(m);
  }
}

// ── Tracing ────────────────────────────────────────────────────────────────

export type SpanStatus = "unset" | "ok" | "error";

/** A finished span exported to listeners. */
export interface FinishedSpan {
  source: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Attributes;
}

/** Sink for finished spans. */
export interface SpanExporter {
  onEnd(span: FinishedSpan): void;
}

/** Collects finished spans in memory for assertions in tests. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: FinishedSpan[] = [];
  onEnd(span: FinishedSpan): void {
    this.spans.push(span);
  }
  clear(): void {
    this.spans.length = 0;
  }
}

/** An in-flight span. Set attributes/status, then `end()`. */
export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes: Attributes = {};
  status: SpanStatus = "unset";
  private readonly startTime = now();
  private ended = false;

  constructor(
    private readonly source: ActivitySource,
    readonly name: string,
    parent?: Span,
  ) {
    this.traceId = parent?.traceId ?? randomHex(32);
    this.spanId = randomHex(16);
    this.parentSpanId = parent?.spanId;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  recordError(err: unknown): this {
    this.status = "error";
    this.attributes["error"] = true;
    this.attributes["error.message"] = err instanceof Error ? err.message : String(err);
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const endTime = now();
    this.source._export({
      source: this.source.name,
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      status: this.status,
      attributes: this.attributes,
    });
  }
}

/**
 * Named span factory. Mirrors .NET `ActivitySource`. Spans are no-ops (never
 * exported) until at least one `SpanExporter` is attached.
 */
export class ActivitySource {
  private readonly exporters = new Set<SpanExporter>();

  constructor(readonly name: string, readonly version: string = "1.0.0") {}

  startSpan(name: string, parent?: Span): Span {
    return new Span(this, name, parent);
  }

  /** Runs `fn` inside a span, ending it automatically and recording errors. */
  async withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, parent?: Span): Promise<T> {
    const span = this.startSpan(name, parent);
    try {
      const result = await fn(span);
      if (span.status === "unset") span.setStatus("ok");
      return result;
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  addExporter(exporter: SpanExporter): void {
    this.exporters.add(exporter);
  }

  removeExporter(exporter: SpanExporter): void {
    this.exporters.delete(exporter);
  }

  /** @internal */
  _export(span: FinishedSpan): void {
    for (const e of this.exporters) e.onEnd(span);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function matches(attrs: Attributes, where?: Partial<Attributes>): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (attrs[k] !== v) return false;
  }
  return true;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function randomHex(chars: number): string {
  let out = "";
  for (let i = 0; i < chars; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
