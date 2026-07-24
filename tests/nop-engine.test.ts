// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Full-parity NOP orchestration-engine tests, mirroring the .NET
// NPS.Tests.Nop suite: condition truth table, input mapper (+depth limit),
// aggregation strategies, K-of-N + preflight execution with a fake streaming
// worker client, saga compensation (strict vs best-effort), and HMAC callback
// signatures.

import { describe, expect, it } from "vitest";

import { evaluateCondition, NopConditionError } from "../src/nop/condition-evaluator.js";
import { resolvePath, buildParams, NopMappingError } from "../src/nop/input-mapper.js";
import { aggregate, merge, aggregateEndNodes } from "../src/nop/result-aggregator.js";
import { validateCallbackUrl, isPrivateHost } from "../src/nop/callback-validator.js";
import { AggregateStrategy, CompensationPolicy } from "../src/nop/models.js";
import type { DagNode, TaskDag } from "../src/nop/models.js";
import { TaskFrame, DelegateFrame, AlignStreamFrame } from "../src/nop/frames.js";
import {
  NopOrchestrator,
  InMemoryNopTaskStore,
  buildCallbackSignature,
} from "../src/nop/orchestrator.js";
import type {
  INopWorkerClient,
  PreflightResult,
} from "../src/nop/worker-client.js";
import { TaskState } from "../src/nop/models.js";

// ── Context helper ──────────────────────────────────────────────────────────

function ctx(...entries: [string, unknown][]): Map<string, unknown> {
  return new Map(entries);
}

// ══════════════════════════════════════════════════════════════════════════════
// Condition evaluator — CEL-subset truth table
// ══════════════════════════════════════════════════════════════════════════════

describe("evaluateCondition — truth table", () => {
  it("numeric > (true / false)", () => {
    expect(evaluateCondition("$.analyze.score > 0.7", ctx(["analyze", { score: 0.92 }]))).toBe(true);
    expect(evaluateCondition("$.analyze.score > 0.7", ctx(["analyze", { score: 0.5 }]))).toBe(false);
  });

  it("numeric >= exact match", () => {
    expect(evaluateCondition("$.n.val >= 5", ctx(["n", { val: 5 }]))).toBe(true);
  });

  it("numeric < and <=", () => {
    expect(evaluateCondition("$.n.count < 10", ctx(["n", { count: 3 }]))).toBe(true);
    expect(evaluateCondition("$.n.count <= 10", ctx(["n", { count: 10 }]))).toBe(true);
  });

  it("string == / !=", () => {
    expect(evaluateCondition('$.c.label == "positive"', ctx(["c", { label: "positive" }]))).toBe(true);
    expect(evaluateCondition('$.c.label == "positive"', ctx(["c", { label: "negative" }]))).toBe(false);
    expect(evaluateCondition('$.n.status != "ok"', ctx(["n", { status: "error" }]))).toBe(true);
  });

  it("null comparisons", () => {
    expect(evaluateCondition("$.n.missing == null", ctx(["n", {}]))).toBe(true);
    expect(evaluateCondition("$.n.x != null", ctx(["n", { x: 1 }]))).toBe(true);
  });

  it("boolean && / || / !", () => {
    expect(evaluateCondition("$.n.score > 0.7 && $.n.count > 0", ctx(["n", { score: 0.9, count: 5 }]))).toBe(true);
    expect(evaluateCondition("$.n.score > 0.7 && $.n.count > 0", ctx(["n", { score: 0.9, count: 0 }]))).toBe(false);
    expect(evaluateCondition("$.n.a > 5 || $.n.b == 0", ctx(["n", { a: 1, b: 0 }]))).toBe(true);
    expect(evaluateCondition("!$.n.ok", ctx(["n", { ok: false }]))).toBe(true);
  });

  it("grouping changes evaluation order", () => {
    expect(evaluateCondition("($.n.a > 0 || $.n.b > 0) && $.n.c > 0", ctx(["n", { a: 0, b: 1, c: 1 }]))).toBe(true);
  });

  it("literals and empty condition", () => {
    expect(evaluateCondition("true", ctx())).toBe(true);
    expect(evaluateCondition("false", ctx())).toBe(false);
    expect(evaluateCondition("", ctx())).toBe(true);
  });

  it("unknown token throws NopConditionError", () => {
    expect(() => evaluateCondition("$.n.x @@ 1", ctx())).toThrow(NopConditionError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Input mapper — resolve + depth limit + buildParams
// ══════════════════════════════════════════════════════════════════════════════

describe("input mapper", () => {
  it("resolves a top-level node to its full result", () => {
    expect(resolvePath("$.fetch", ctx(["fetch", { count: 3 }]))).toEqual({ count: 3 });
  });

  it("resolves nested fields", () => {
    expect(resolvePath("$.analyze.result.score", ctx(["analyze", { result: { score: 0.92 } }]))).toBe(0.92);
  });

  it("returns undefined for missing node / field", () => {
    expect(resolvePath("$.missing.field", ctx())).toBeUndefined();
    expect(resolvePath("$.fetch.no_such", ctx(["fetch", { count: 1 }]))).toBeUndefined();
  });

  it("throws on missing '$.' prefix", () => {
    expect(() => resolvePath("fetch.field", ctx())).toThrow(NopMappingError);
  });

  it("throws on empty path", () => {
    expect(() => resolvePath("", ctx())).toThrow(NopMappingError);
  });

  it("throws when depth exceeds MaxInputMappingDepth (8)", () => {
    const deep = "$.n." + Array(10).fill("a").join(".");
    expect(() => resolvePath(deep, ctx(["n", {}]))).toThrow(NopMappingError);
  });

  it("buildParams: null mapping → empty object", () => {
    expect(buildParams(undefined, ctx())).toEqual({});
  });

  it("buildParams: string path resolves value", () => {
    const out = buildParams({ products: "$.fetch.items" }, ctx(["fetch", { items: [1, 2, 3] }]));
    expect(out.products).toEqual([1, 2, 3]);
  });

  it("buildParams: array of paths builds a list", () => {
    const out = buildParams({ combined: ["$.a.v", "$.b.v"] }, ctx(["a", { v: 1 }], ["b", { v: 2 }]));
    expect(out.combined).toEqual([1, 2]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Result aggregator — strategies
// ══════════════════════════════════════════════════════════════════════════════

describe("result aggregator", () => {
  it("merge combines fields", () => {
    expect(merge([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
  });
  it("merge: last-write-wins on conflict", () => {
    expect(merge([{ x: 1 }, { x: 99 }])).toEqual({ x: 99 });
  });
  it("merge: non-object wrapped under _result_i", () => {
    expect(merge([{ a: 1 }, 42])).toEqual({ a: 1, _result_1: 42 });
  });
  it("merge: empty list → empty object", () => {
    expect(merge([])).toEqual({});
  });
  it("first returns first element", () => {
    expect(aggregate(AggregateStrategy.FIRST, [{ v: 1 }, { v: 2 }])).toEqual({ v: 1 });
  });
  it("all returns array", () => {
    expect(aggregate(AggregateStrategy.ALL, [{ v: 1 }, { v: 2 }])).toEqual([{ v: 1 }, { v: 2 }]);
  });
  it("fastest_k takes minRequired", () => {
    const r = aggregate(AggregateStrategy.FASTEST_K, [{ v: 1 }, { v: 2 }, { v: 3 }], 2);
    expect(r).toEqual([{ v: 1 }, { v: 2 }]);
  });
  it("fastest_k zero minRequired takes all", () => {
    expect(aggregate(AggregateStrategy.FASTEST_K, [{ v: 1 }, { v: 2 }], 0)).toHaveLength(2);
  });
  it("aggregateEndNodes only includes end nodes", () => {
    const all = new Map<string, unknown>([
      ["fetch", { items: [1] }],
      ["analyze", { score: 0.9 }],
      ["report", { summary: "ok" }],
    ]);
    const r = aggregateEndNodes(["report"], all) as Record<string, unknown>;
    expect(r).toHaveProperty("summary");
    expect(r).not.toHaveProperty("score");
  });
  it("aggregateEndNodes empty → empty object", () => {
    expect(aggregateEndNodes(["report"], new Map())).toEqual({});
  });
  it("unknown strategy falls back to merge", () => {
    expect(aggregate("unknown_strategy", [{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Callback URL validation (https + SSRF guard)
// ══════════════════════════════════════════════════════════════════════════════

describe("callback URL validation", () => {
  it("accepts a public https URL", () => {
    expect(validateCallbackUrl("https://hooks.example.com/cb")).toBeNull();
  });
  it("rejects http scheme", () => {
    expect(validateCallbackUrl("http://hooks.example.com/cb")).toContain("https://");
  });
  it("rejects empty URL", () => {
    expect(validateCallbackUrl("")).toContain("must not be empty");
  });
  it("rejects private / loopback hosts (SSRF)", () => {
    expect(validateCallbackUrl("https://localhost/cb")).toContain("SSRF");
    expect(validateCallbackUrl("https://127.0.0.1/cb")).toContain("SSRF");
    expect(validateCallbackUrl("https://10.1.2.3/cb")).toContain("SSRF");
    expect(validateCallbackUrl("https://192.168.0.5/cb")).toContain("SSRF");
    expect(validateCallbackUrl("https://172.16.5.5/cb")).toContain("SSRF");
    expect(validateCallbackUrl("https://169.254.1.1/cb")).toContain("SSRF");
  });
  it("isPrivateHost detection", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Fake streaming worker client (mirrors PkMockWorkerClient)
// ══════════════════════════════════════════════════════════════════════════════

type Handler = (frame: DelegateFrame) => { ok: true; data: unknown } | { ok: false; code: string };

class FakeWorkerClient implements INopWorkerClient {
  private readonly results = new Map<string, unknown>();
  private readonly fails = new Map<string, string>();
  private readonly handlers = new Map<string, Handler>();

  preflightAvailable = true;
  preflightUnavailableReason: string | undefined;
  preflightProbes: string[] = [];

  setupSuccess(nodeId: string, data: unknown): void { this.results.set(nodeId, data); }
  setupFailure(nodeId: string, code = "ERR"): void { this.fails.set(nodeId, code); }
  setupHandler(nodeId: string, h: Handler): void { this.handlers.set(nodeId, h); }

  async *delegate(frame: DelegateFrame): AsyncIterable<AlignStreamFrame> {
    const nodeId = frame.nodeId ?? frame.subtaskId;
    let data: unknown;
    let errorCode: string | undefined;

    const handler = this.handlers.get(nodeId);
    if (handler) {
      const r = handler(frame);
      if (r.ok) data = r.data; else errorCode = r.code;
    } else if (this.fails.has(nodeId)) {
      errorCode = this.fails.get(nodeId);
    } else {
      data = this.results.get(nodeId) ?? {};
    }

    yield new AlignStreamFrame(
      "stream-" + nodeId, frame.taskId, frame.subtaskId, 0, true, frame.agentNid,
      errorCode ? undefined : (data as Record<string, unknown> | undefined),
      errorCode ? { errorCode, message: "fail" } : undefined,
    );
  }

  async preflight(agentNid: string): Promise<PreflightResult> {
    this.preflightProbes.push(agentNid);
    return { agentNid, available: this.preflightAvailable, unavailableReason: this.preflightUnavailableReason };
  }
}

function node(id: string, extra?: Partial<DagNode>): DagNode {
  return { id, action: `nwp://node/${id}`, agent: id, ...extra };
}

function build(): { orch: NopOrchestrator; worker: FakeWorkerClient } {
  const worker = new FakeWorkerClient();
  const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), {
    validateSenderNid: false,
    enableCallback: false,
    callbackRetryBaseDelayMs: 0,
  });
  return { orch, worker };
}

function fanIn(sources: string[], sink: string, minRequired = 0, preflight = false): TaskFrame {
  const nodes = [
    ...sources.map((s) => node(s)),
    node(sink, { inputFrom: sources, minRequired }),
  ];
  const edges = sources.map((s) => ({ from: s, to: sink }));
  const dag: TaskDag = { nodes, edges };
  // maxRetries=0 keeps failing-node K-of-N tests fast (retry is exercised separately).
  return new TaskFrame(
    "task-" + Math.random().toString(36).slice(2), dag,
    undefined, undefined, undefined, undefined, 0, undefined, 3600, 0, undefined, preflight,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Preflight
// ══════════════════════════════════════════════════════════════════════════════

describe("preflight", () => {
  it("disabled → skips probe and executes", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { done: true });
    const dag: TaskDag = { nodes: [node("a")], edges: [] };
    const res = await orch.execute(new TaskFrame("t", dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(worker.preflightProbes).toHaveLength(0);
  });

  it("all available → executes", async () => {
    const { orch, worker } = build();
    worker.preflightAvailable = true;
    worker.setupSuccess("a", { done: true });
    const dag: TaskDag = { nodes: [node("a")], edges: [] };
    const frame = new TaskFrame("t", dag, undefined, undefined, undefined, undefined, 0, undefined, 3600, 2, undefined, true);
    const res = await orch.execute(frame);
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(worker.preflightProbes).toContain("a");
  });

  it("agent unavailable → NOP-RESOURCE-INSUFFICIENT", async () => {
    const { orch, worker } = build();
    worker.preflightAvailable = false;
    worker.preflightUnavailableReason = "capacity_exceeded";
    const dag: TaskDag = { nodes: [node("a")], edges: [] };
    const frame = new TaskFrame("t", dag, undefined, undefined, undefined, undefined, 0, undefined, 3600, 2, undefined, true);
    const res = await orch.execute(frame);
    expect(res.state).toBe(TaskState.FAILED);
    expect(res.error?.code).toBe("NOP-RESOURCE-INSUFFICIENT");
    expect(res.error?.message).toContain("capacity_exceeded");
  });

  it("multi-node dedups probes by agent", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("src", { x: 1 });
    worker.setupSuccess("sink", { y: 2 });
    const res = await orch.execute(fanIn(["src"], "sink", 0, true));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(new Set(worker.preflightProbes)).toEqual(new Set(["src", "sink"]));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// K-of-N execution
// ══════════════════════════════════════════════════════════════════════════════

describe("K-of-N execution", () => {
  it("default all-required, one fails → task fails", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { v: 1 });
    worker.setupFailure("b");
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a", "b"], "sink", 0));
    expect(res.state).toBe(TaskState.FAILED);
  });

  it("1-of-2, one fails → task succeeds", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { v: 1 });
    worker.setupFailure("b");
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a", "b"], "sink", 1));
    expect(res.state).toBe(TaskState.COMPLETED);
  });

  it("2-of-3, one fails → task succeeds", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { v: 1 });
    worker.setupSuccess("b", { v: 2 });
    worker.setupFailure("c");
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a", "b", "c"], "sink", 2));
    expect(res.state).toBe(TaskState.COMPLETED);
  });

  it("2-of-3, two fail → task fails with NOP-SYNC-DEPENDENCY-FAILED", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { v: 1 });
    worker.setupFailure("b");
    worker.setupFailure("c");
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a", "b", "c"], "sink", 2));
    expect(res.state).toBe(TaskState.FAILED);
    expect(res.error?.code).toBe("NOP-SYNC-DEPENDENCY-FAILED");
  });

  it("all succeed → completes", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("a", { v: 1 });
    worker.setupSuccess("b", { v: 2 });
    worker.setupSuccess("c", { v: 3 });
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a", "b", "c"], "sink", 2));
    expect(res.state).toBe(TaskState.COMPLETED);
  });

  it("single source, fails → task fails", async () => {
    const { orch, worker } = build();
    worker.setupFailure("a");
    worker.setupSuccess("sink", { done: true });
    const res = await orch.execute(fanIn(["a"], "sink", 1));
    expect(res.state).toBe(TaskState.FAILED);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Linear / diamond execution + streaming client
// ══════════════════════════════════════════════════════════════════════════════

describe("streaming DAG execution", () => {
  it("linear chain completes and aggregates end node", async () => {
    const { orch, worker } = build();
    worker.setupSuccess("fetch", { items: 3 });
    worker.setupSuccess("report", { summary: "ok" });
    const dag: TaskDag = {
      nodes: [node("fetch"), node("report", { inputFrom: ["fetch"] })],
      edges: [{ from: "fetch", to: "report" }],
    };
    const res = await orch.execute(new TaskFrame("t", dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(res.aggregatedResult).toEqual({ summary: "ok" });
  });

  it("stream sender-nid mismatch is rejected when validation is on", async () => {
    const worker = new FakeWorkerClient();
    // Force a mismatched sender by overriding delegate.
    worker.delegate = async function* (frame: DelegateFrame) {
      yield new AlignStreamFrame("s", frame.taskId, frame.subtaskId, 0, true, "urn:nps:agent:evil", { ok: true });
    } as unknown as INopWorkerClient["delegate"];
    const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), { enableCallback: false });
    const dag: TaskDag = { nodes: [node("a")], edges: [] };
    const res = await orch.execute(new TaskFrame("t", dag, undefined, undefined, undefined, undefined, 0, undefined, 3600, 0));
    expect(res.state).toBe(TaskState.FAILED);
    expect(res.error?.code).toBe("NOP-SYNC-DEPENDENCY-FAILED"); // end node failed via nid mismatch
    expect(res.nodeResults["a"].error?.code).toBe("NOP-STREAM-NID-MISMATCH");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Retry with retry_on
// ══════════════════════════════════════════════════════════════════════════════

describe("retry", () => {
  it("retry_on gates which error codes are retried", async () => {
    const worker = new FakeWorkerClient();
    let calls = 0;
    worker.setupHandler("a", () => {
      calls++;
      return { ok: false, code: "NOP-DELEGATE-TIMEOUT" };
    });
    const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), { enableCallback: false });
    const dag: TaskDag = {
      nodes: [node("a", { retryPolicy: { maxRetries: 2, backoff: "fixed" as never, baseDelayMs: 0, retryOn: ["SOME-OTHER"] } })],
      edges: [],
    };
    const res = await orch.execute(new TaskFrame("t", dag));
    expect(res.state).toBe(TaskState.FAILED);
    // retryOn does not include the returned code → no retry, single attempt.
    expect(calls).toBe(1);
  });

  it("retries retriable codes up to maxRetries then succeeds", async () => {
    const worker = new FakeWorkerClient();
    let calls = 0;
    worker.setupHandler("a", () => {
      calls++;
      return calls < 3 ? { ok: false, code: "NOP-DELEGATE-TIMEOUT" } : { ok: true, data: { done: true } };
    });
    const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), { enableCallback: false });
    const dag: TaskDag = {
      nodes: [node("a", { retryPolicy: { maxRetries: 3, backoff: "fixed" as never, baseDelayMs: 0 } })],
      edges: [],
    };
    const res = await orch.execute(new TaskFrame("t", dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(calls).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Saga compensation
// ══════════════════════════════════════════════════════════════════════════════

describe("saga compensation", () => {
  it("best-effort compensates completed predecessor on failure", async () => {
    const worker = new FakeWorkerClient();
    let refundCalls = 0;
    let refundParams: unknown;
    worker.setupHandler("charge", (frame) => {
      if (frame.action === "nwp://payments/refund") {
        refundCalls++;
        refundParams = frame.params;
        return { ok: true, data: { refunded: true } };
      }
      return { ok: true, data: { charge_id: "ch_1", amount: 25 } };
    });
    worker.setupFailure("ship", "SHIP-FAILED");

    const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), { validateSenderNid: false, enableCallback: false });
    const dag: TaskDag = {
      nodes: [
        node("charge", {
          action: "nwp://payments/charge",
          compensate_action: "nwp://payments/refund",
          compensate_params_mapping: { charge_id: "$.charge.charge_id" },
        }),
        node("ship", { action: "nwp://shipping/ship", inputFrom: ["charge"] }),
      ],
      edges: [{ from: "charge", to: "ship" }],
    };
    // default compensation_policy → best_effort; maxRetries=0 for speed
    const res = await orch.execute(new TaskFrame("t", dag, undefined, undefined, undefined, undefined, 0, CompensationPolicy.BEST_EFFORT, 3600, 0));
    expect(res.state).toBe(TaskState.FAILED);
    expect(refundCalls).toBe(1);
    expect(res.compensation).toBeDefined();
    expect(res.compensation!.attempted).toBe(1);
    expect(res.compensation!.succeeded).toBe(1);
    expect((refundParams as Record<string, unknown>).charge_id).toBe("ch_1");
  });

  it("strict policy, missing compensate_action → NOP-COMPENSATION-NOT-SUPPORTED", async () => {
    const worker = new FakeWorkerClient();
    worker.setupSuccess("charge", { charge_id: "ch_1" });
    worker.setupFailure("ship", "SHIP-FAILED");
    const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), { validateSenderNid: false, enableCallback: false });
    const dag: TaskDag = {
      nodes: [
        node("charge", { action: "nwp://payments/charge" }),
        node("ship", { action: "nwp://shipping/ship", inputFrom: ["charge"] }),
      ],
      edges: [{ from: "charge", to: "ship" }],
    };
    const res = await orch.execute(new TaskFrame("t", dag, undefined, undefined, undefined, undefined, 0, CompensationPolicy.STRICT, 3600, 0));
    expect(res.state).toBe(TaskState.FAILED);
    expect(res.error?.code).toBe("NOP-COMPENSATION-NOT-SUPPORTED");
    expect(res.compensation).toBeDefined();
    expect(res.compensation!.attempted).toBe(0);
    expect(res.compensation!.failed).toBe(1);
    expect(res.compensation!.failedNodeIds).toEqual(["charge"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Callback HMAC signature
// ══════════════════════════════════════════════════════════════════════════════

describe("callback HMAC signature", () => {
  // 32 zero bytes, base64url-encoded.
  const key32 = Buffer.alloc(32).toString("base64url");

  it("produces sha256=<lowerhex> for a valid 32-byte base64url key", async () => {
    const sig = await buildCallbackSignature(key32, '{"hello":"world"}');
    expect(sig).not.toBeNull();
    expect(sig!).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("matches an independently computed HMAC-SHA256", async () => {
    const payload = '{"task_id":"t1"}';
    const sig = await buildCallbackSignature(key32, payload);
    // Independent computation via Node crypto.
    const { createHmac } = await import("node:crypto");
    const expected = "sha256=" + createHmac("sha256", Buffer.alloc(32)).update(payload).digest("hex");
    expect(sig).toBe(expected);
  });

  it("returns null when secret is missing or not a 32-byte key", async () => {
    expect(await buildCallbackSignature(undefined, "x")).toBeNull();
    expect(await buildCallbackSignature("", "x")).toBeNull();
    expect(await buildCallbackSignature(Buffer.alloc(16).toString("base64url"), "x")).toBeNull();
  });

  it("fires an HMAC-signed callback when enabled", async () => {
    const worker = new FakeWorkerClient();
    worker.setupSuccess("a", { ok: true });
    let capturedSig: string | null = null;
    let capturedBody = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedSig = (init.headers as Record<string, string>)["X-NPS-Signature"] ?? null;
      capturedBody = init.body as string;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const orch = new NopOrchestrator(worker, new InMemoryNopTaskStore(), {
        validateSenderNid: false, enableCallback: true, callbackRetryBaseDelayMs: 0,
      });
      const dag: TaskDag = { nodes: [node("a")], edges: [] };
      const frame = new TaskFrame(
        "t", dag, undefined, "https://hooks.example.com/cb",
        undefined, undefined, 0, undefined, 3600, 2, key32, false,
      );
      const res = await orch.execute(frame);
      expect(res.state).toBe(TaskState.COMPLETED);
      // Give the fire-and-forget callback a tick to run.
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedSig).toMatch(/^sha256=[0-9a-f]{64}$/);
      const { createHmac } = await import("node:crypto");
      const expected = "sha256=" + createHmac("sha256", Buffer.alloc(32)).update(capturedBody).digest("hex");
      expect(capturedSig).toBe(expected);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
