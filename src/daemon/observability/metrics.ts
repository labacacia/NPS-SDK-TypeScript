// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Lightweight Prometheus-compatible counter / gauge registry backing the
// `/metrics` endpoint. Port of the .NET `NPS.Daemon.Observability.Metrics`
// (`MetricsRegistry`, `MetricsEndpoint`).
//
// The exposition text (HELP/TYPE lines, label escaping, number formatting) and
// the endpoint content type match the .NET reference byte-for-byte.

/** Prometheus/OpenMetrics text exposition content type. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// ASCII Unit Separator — the .NET Counter uses \x1F to join label values into
// a stable cell key. Kept identical so behaviour matches for control-char edge cases.
const CELL_SEPARATOR = "\x1f";

interface MetricEntry {
  writeTo(out: string[]): void;
}

/** Monotonic counter; one cell per label-value tuple. */
export class Counter implements MetricEntry {
  private readonly cells = new Map<string, { value: number }>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly labels: readonly string[],
  ) {
    if (labels.length === 0) this.cells.set("", { value: 0 });
  }

  /** Increment by `by` (default 1) with the given label values (in registered order). */
  inc(by = 1, ...labelValues: string[]): void {
    const key = this.cellKey(labelValues);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { value: 0 };
      this.cells.set(key, cell);
    }
    cell.value += by;
  }

  /** Increment a labelled cell by 1. */
  incLabels(...labelValues: string[]): void {
    this.inc(1, ...labelValues);
  }

  writeTo(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}\n`);
    out.push(`# TYPE ${this.name} counter\n`);
    for (const [key, cell] of this.cells) {
      let line = this.name;
      if (this.labels.length > 0) {
        const parts = key.split(CELL_SEPARATOR);
        const pairs: string[] = [];
        for (let i = 0; i < this.labels.length; i++) {
          const v = i < parts.length ? parts[i]! : "";
          pairs.push(`${this.labels[i]}="${escapeLabel(v)}"`);
        }
        line += `{${pairs.join(",")}}`;
      }
      line += ` ${formatNumber(cell.value)}\n`;
      out.push(line);
    }
  }

  private cellKey(labelValues: string[]): string {
    if (this.labels.length === 0) return "";
    const parts: string[] = [];
    for (let i = 0; i < this.labels.length; i++) {
      parts.push(i < labelValues.length ? labelValues[i]! : "");
    }
    return parts.join(CELL_SEPARATOR);
  }
}

/** Single-valued gauge; may go up and down. */
export class Gauge implements MetricEntry {
  private _value = 0;

  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  set(value: number): void {
    this._value = value;
  }
  inc(): void {
    this._value += 1;
  }
  dec(): void {
    this._value -= 1;
  }
  add(by: number): void {
    this._value += by;
  }
  get value(): number {
    return this._value;
  }

  writeTo(out: string[]): void {
    out.push(`# HELP ${this.name} ${this.help}\n`);
    out.push(`# TYPE ${this.name} gauge\n`);
    out.push(`${this.name} ${formatNumber(this._value)}\n`);
  }
}

/** Prometheus-compatible registry for a small, known-up-front metric set. */
export class MetricsRegistry {
  private readonly entries: MetricEntry[] = [];

  /** Registers a counter (monotonic, accumulates per labelset). */
  registerCounter(name: string, help: string, ...labelNames: string[]): Counter {
    const c = new Counter(name, help, labelNames);
    this.entries.push(c);
    return c;
  }

  /** Registers a gauge (sampled, may go up and down). */
  registerGauge(name: string, help: string): Gauge {
    const g = new Gauge(name, help);
    this.entries.push(g);
    return g;
  }

  /** Renders the registry in Prometheus exposition format. */
  render(): string {
    const out: string[] = [];
    for (const e of this.entries) e.writeTo(out);
    return out.join("");
  }
}

/**
 * Web-`fetch` handler for `GET /metrics`. Writes the registry snapshot in the
 * Prometheus text exposition format. Optional bearer-token auth mirrors the
 * .NET `MetricsEndpoint.MapMetrics` semantics:
 *   - no token configured, not required → open
 *   - not configured, required          → 404 (endpoint hidden)
 *   - configured                        → constant-time Bearer check
 */
export function createMetricsHandler(
  registry: MetricsRegistry,
  opts: { bearerToken?: string; requireBearerToken?: boolean } = {},
): (request: Request) => Promise<Response> {
  return (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== "/metrics" || request.method !== "GET") {
      return Promise.resolve(new Response("", { status: 404 }));
    }

    const auth = authorize(request, opts.bearerToken, opts.requireBearerToken ?? false);
    if (auth) return Promise.resolve(auth);

    return Promise.resolve(
      new Response(registry.render(), {
        status: 200,
        headers: { "Content-Type": METRICS_CONTENT_TYPE },
      }),
    );
  };
}

// ── Private ────────────────────────────────────────────────────────────────

function authorize(
  request: Request,
  bearerToken: string | undefined,
  requireBearerToken: boolean,
): Response | null {
  if (!bearerToken || bearerToken.trim() === "") {
    if (!requireBearerToken) return null;
    return new Response("", { status: 404 });
  }
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return new Response("", { status: 401 });
  const supplied = header.slice(prefix.length);
  if (fixedTimeEquals(supplied, bearerToken)) return null;
  return new Response("", { status: 401 });
}

function fixedTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeLabel(v: string): string {
  if (!/[\\"\n]/.test(v)) return v;
  let out = "";
  for (const c of v) {
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\n") out += "\\n";
    else out += c;
  }
  return out;
}

/** Matches .NET's "0.################" invariant formatting (up to 16 fraction digits). */
function formatNumber(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  let s = v.toFixed(16);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
