// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Daemon observability tests: health/readiness responses, Prometheus metrics
// exposition, structured logging, and graceful shutdown coordination.

import { describe, it, expect } from "vitest";
import {
  renderHealthz,
  renderReadyz,
  createHealthHandler,
  DelegateReadinessProbe,
  HEALTH_JSON_CONTENT_TYPE,
  MetricsRegistry,
  createMetricsHandler,
  METRICS_CONTENT_TYPE,
  JsonLogger,
  resolveLogLevel,
  formatLogRecord,
  GracefulShutdown,
  ShutdownState,
} from "../../src/daemon/observability/index.js";

// ── Health ───────────────────────────────────────────────────────────────

describe("health probes", () => {
  it("healthz renders 200 {status:ok}", () => {
    const r = renderHealthz();
    expect(r.statusCode).toBe(200);
    expect(r.contentType).toBe(HEALTH_JSON_CONTENT_TYPE);
    expect(JSON.parse(r.body)).toEqual({ status: "ok" });
  });

  it("readyz with no probes → 200 ok", async () => {
    const r = await renderReadyz([]);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: "ok" });
  });

  it("readyz returns first failing probe with 503", async () => {
    const r = await renderReadyz([
      new DelegateReadinessProbe("db", () => Promise.resolve(null)),
      new DelegateReadinessProbe("storage", () => Promise.resolve("disk full")),
    ]);
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ status: "error", reason: "disk full" });
  });

  it("readyz maps a throwing probe to its reason", async () => {
    const r = await renderReadyz([
      new DelegateReadinessProbe("keys", () => Promise.reject(new Error("no key"))),
    ]);
    expect(r.statusCode).toBe(503);
    expect(r.reason).toBe("keys: no key");
  });

  it("fetch handler serves /healthz and /readyz", async () => {
    const handler = createHealthHandler({
      readinessProbes: () => [new DelegateReadinessProbe("ok", () => Promise.resolve(null))],
    });
    const health = await handler(new Request("http://x/healthz"));
    expect(health.status).toBe(200);
    const ready = await handler(new Request("http://x/readyz"));
    expect(ready.status).toBe(200);
    const other = await handler(new Request("http://x/nope"));
    expect(other.status).toBe(404);
  });

  it("healthz fails 503 while stopping (liveness gate)", async () => {
    const handler = createHealthHandler({ isStopping: () => true });
    const resp = await handler(new Request("http://x/healthz"));
    expect(resp.status).toBe(503);
  });
});

// ── Metrics ──────────────────────────────────────────────────────────────

describe("metrics registry", () => {
  it("renders counters and gauges in Prometheus format", () => {
    const reg = new MetricsRegistry();
    const c = reg.registerCounter("nps_requests_total", "Total requests", "method");
    const g = reg.registerGauge("nps_inflight", "In-flight requests");
    c.incLabels("GET");
    c.incLabels("GET");
    c.incLabels("POST");
    g.set(3);
    const out = reg.render();
    expect(out).toContain("# HELP nps_requests_total Total requests");
    expect(out).toContain("# TYPE nps_requests_total counter");
    expect(out).toContain('nps_requests_total{method="GET"} 2');
    expect(out).toContain('nps_requests_total{method="POST"} 1');
    expect(out).toContain("# TYPE nps_inflight gauge");
    expect(out).toContain("nps_inflight 3");
  });

  it("unlabelled counter starts at 0 and increments", () => {
    const reg = new MetricsRegistry();
    const c = reg.registerCounter("hits", "hits");
    expect(reg.render()).toContain("hits 0");
    c.inc(5);
    expect(reg.render()).toContain("hits 5");
  });

  it("escapes label values", () => {
    const reg = new MetricsRegistry();
    const c = reg.registerCounter("m", "m", "path");
    c.incLabels('a"b\\c');
    expect(reg.render()).toContain('m{path="a\\"b\\\\c"} 1');
  });

  it("fetch handler serves /metrics with the right content type", async () => {
    const reg = new MetricsRegistry();
    reg.registerCounter("x", "x").inc();
    const handler = createMetricsHandler(reg);
    const resp = await handler(new Request("http://x/metrics"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    expect(await resp.text()).toContain("x 1");
  });

  it("bearer-token auth: 401 without token, 200 with", async () => {
    const reg = new MetricsRegistry();
    const handler = createMetricsHandler(reg, { bearerToken: "s3cret" });
    const noAuth = await handler(new Request("http://x/metrics"));
    expect(noAuth.status).toBe(401);
    const good = await handler(
      new Request("http://x/metrics", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(good.status).toBe(200);
    const bad = await handler(
      new Request("http://x/metrics", { headers: { authorization: "Bearer wrong" } }),
    );
    expect(bad.status).toBe(401);
  });

  it("required-but-unconfigured token hides the endpoint (404)", async () => {
    const reg = new MetricsRegistry();
    const handler = createMetricsHandler(reg, { requireBearerToken: true });
    const resp = await handler(new Request("http://x/metrics"));
    expect(resp.status).toBe(404);
  });
});

// ── Logging ──────────────────────────────────────────────────────────────

describe("structured logging", () => {
  it("emits one JSON line with the expected fields", () => {
    const lines: string[] = [];
    const log = new JsonLogger({
      logger: "test",
      level: "info",
      sink: (l) => lines.push(l),
      clock: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    log.info("hello", { traceId: "abc123" });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      timestamp: "2026-07-09T00:00:00.000Z",
      level: "info",
      msg: "hello",
      logger: "test",
      trace_id: "abc123",
    });
  });

  it("honours the minimum level", () => {
    const lines: string[] = [];
    const log = new JsonLogger({ level: "warn", sink: (l) => lines.push(l) });
    log.debug("dropped");
    log.info("dropped");
    log.warn("kept");
    log.error("kept");
    expect(lines).toHaveLength(2);
  });

  it("serializes exceptions", () => {
    const lines: string[] = [];
    const log = new JsonLogger({ level: "error", sink: (l) => lines.push(l) });
    log.error("boom", { exception: new Error("oops") });
    const rec = JSON.parse(lines[0]!);
    expect(rec.exception).toContain("oops");
  });

  it("resolveLogLevel reads NPS_LOG_LEVEL, case-insensitive, with aliases", () => {
    expect(resolveLogLevel("info", { NPS_LOG_LEVEL: "DEBUG" })).toBe("debug");
    expect(resolveLogLevel("info", { NPS_LOG_LEVEL: "Warning" })).toBe("warn");
    expect(resolveLogLevel("info", { NPS_LOG_LEVEL: "information" })).toBe("info");
    expect(resolveLogLevel("info", {})).toBe("info");
    expect(resolveLogLevel("info", { NPS_LOG_LEVEL: "garbage" })).toBe("info");
  });

  it("formatLogRecord round-trips", () => {
    const line = formatLogRecord({
      timestamp: "t",
      level: "info",
      msg: "m",
      logger: "l",
    });
    expect(JSON.parse(line)).toEqual({ timestamp: "t", level: "info", msg: "m", logger: "l" });
  });
});

// ── Shutdown ─────────────────────────────────────────────────────────────

describe("graceful shutdown", () => {
  it("ShutdownState flips isStopping", () => {
    const s = new ShutdownState();
    expect(s.isStopping).toBe(false);
    s.markStopping();
    expect(s.isStopping).toBe(true);
  });

  it("runs drain callbacks and marks stopping", async () => {
    const order: string[] = [];
    const gs = new GracefulShutdown({ drainTimeoutMs: 1000 });
    gs.onDrain(() => {
      order.push("a");
    }).onDrain(async () => {
      await Promise.resolve();
      order.push("b");
    });
    expect(gs.isStopping).toBe(false);
    await gs.shutdown("SIGTERM");
    expect(gs.isStopping).toBe(true);
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("is idempotent", async () => {
    let calls = 0;
    const gs = new GracefulShutdown();
    gs.onDrain(() => {
      calls++;
    });
    await gs.shutdown();
    await gs.shutdown();
    expect(calls).toBe(1);
  });

  it("logs signal-received and complete via the log hook", async () => {
    const logs: string[] = [];
    const gs = new GracefulShutdown({ onLog: (m) => logs.push(m) });
    await gs.shutdown("SIGINT");
    expect(logs.some((l) => l.includes("shutdown signal received"))).toBe(true);
    expect(logs).toContain("shutdown complete");
  });

  it("bounds slow drain callbacks by the timeout", async () => {
    const gs = new GracefulShutdown({ drainTimeoutMs: 20 });
    gs.onDrain(() => new Promise<void>(() => {
      /* never resolves */
    }));
    const start = Date.now();
    await gs.shutdown();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(gs.isStopping).toBe(true);
  });
});
