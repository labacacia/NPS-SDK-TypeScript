// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Tests for NOP DagValidator (spec/conformance/nop/dag_validation_vectors.json)
// and NopOrchestrator DAG execution engine (NPS-5 §3, §5).

import { describe, expect, it, vi } from "vitest";
import { validateDag } from "../src/nop/dag-validator.js";
import {
  NopOrchestrator,
  InMemoryNopTaskStore,
  type INopWorkerDispatcher,
  type NodeResult,
} from "../src/nop/orchestrator.js";
import { TaskFrame } from "../src/nop/frames.js";
import type { DagNode, TaskDag } from "../src/nop/models.js";
import { TaskState } from "../src/nop/models.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(id: string, extra?: Partial<DagNode>): DagNode {
  return { id, action: `nwp://demo.example.com/${id}/invoke`, agent: `urn:nps:agent:demo:${id}`, ...extra };
}

function makeTaskFrame(dag: TaskDag, opts: { depth?: number; timeoutMs?: number } = {}): TaskFrame {
  return new TaskFrame(`task-${Math.random().toString(36).slice(2)}`, dag, opts.timeoutMs, undefined, undefined, undefined, opts.depth ?? 0);
}

function okDispatcher(output?: unknown): INopWorkerDispatcher {
  return {
    dispatch: vi.fn(async (nodeId: string): Promise<NodeResult> => ({
      nodeId, ok: true, output: output ?? { result: nodeId },
    })),
  };
}

function failDispatcher(): INopWorkerDispatcher {
  return {
    dispatch: vi.fn(async (nodeId: string): Promise<NodeResult> => ({
      nodeId, ok: false, error: { code: "NOP-TASK-NODE-FAILED", message: `${nodeId} failed` },
    })),
  };
}

// ── DagValidator: spec/conformance/nop/dag_validation_vectors.json ────────────

describe("validateDag — conformance vectors", () => {

  it("nop.dag.001 — valid linear 3-node DAG (fetch → analyze → report)", () => {
    const dag: TaskDag = {
      nodes: [
        makeNode("fetch"),
        makeNode("analyze", { inputFrom: ["fetch"] }),
        makeNode("report",  { inputFrom: ["analyze"] }),
      ],
      edges: [
        { from: "fetch", to: "analyze" },
        { from: "analyze", to: "report" },
      ],
    };
    const r = validateDag(dag);
    expect(r.valid).toBe(true);
    expect(r.topologicalOrder).toHaveLength(3);
    expect(r.roots).toEqual(["fetch"]);
    expect(r.terminals).toEqual(["report"]);
  });

  it("nop.dag.002 — valid diamond: fetch → (analyze_a, analyze_b) → merge", () => {
    const dag: TaskDag = {
      nodes: [
        makeNode("fetch"),
        makeNode("analyze_a", { inputFrom: ["fetch"] }),
        makeNode("analyze_b", { inputFrom: ["fetch"] }),
        makeNode("merge",     { inputFrom: ["analyze_a", "analyze_b"] }),
      ],
      edges: [
        { from: "fetch",     to: "analyze_a" },
        { from: "fetch",     to: "analyze_b" },
        { from: "analyze_a", to: "merge" },
        { from: "analyze_b", to: "merge" },
      ],
    };
    const r = validateDag(dag);
    expect(r.valid).toBe(true);
    expect(r.roots).toEqual(["fetch"]);
    expect(r.terminals).toEqual(["merge"]);
    expect(r.topologicalOrder).toHaveLength(4);
    // fetch must appear before both analyze nodes in topo order
    const ord = r.topologicalOrder!;
    expect(ord.indexOf("fetch")).toBeLessThan(ord.indexOf("analyze_a"));
    expect(ord.indexOf("fetch")).toBeLessThan(ord.indexOf("analyze_b"));
  });

  it("nop.dag.003 — rejects cycle (NOP-TASK-DAG-CYCLE)", () => {
    const dag: TaskDag = {
      nodes: [
        makeNode("a", { inputFrom: ["c"] }),
        makeNode("b", { inputFrom: ["a"] }),
        makeNode("c", { inputFrom: ["b"] }),
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    };
    const r = validateDag(dag);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NOP-TASK-DAG-CYCLE");
  });

  it("nop.dag.004 — rejects DAG with > 32 nodes (NOP-TASK-DAG-TOO-LARGE)", () => {
    const nodes = Array.from({ length: 33 }, (_, i) => makeNode(`n${i}`));
    const dag: TaskDag = { nodes, edges: [] };
    const r = validateDag(dag);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NOP-TASK-DAG-TOO-LARGE");
  });

  it("nop.dag.005 — rejects edge referencing unknown node (NOP-TASK-DAG-INVALID)", () => {
    const dag: TaskDag = {
      nodes: [makeNode("a"), makeNode("b")],
      edges: [{ from: "a", to: "nonexistent" }],
    };
    const r = validateDag(dag);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NOP-TASK-DAG-INVALID");
  });

  it("nop.dag.006 — depth ≥ 3 is caught by orchestrator (NOP-DELEGATE-CHAIN-TOO-DEEP)", async () => {
    const dag: TaskDag = { nodes: [makeNode("n1")], edges: [] };
    const frame        = makeTaskFrame(dag, { depth: 3 });
    const orch         = new NopOrchestrator(okDispatcher(), new InMemoryNopTaskStore());
    const result       = await orch.execute(frame);
    expect(result.state).toBe(TaskState.FAILED);
    expect(result.error?.code).toBe("NOP-DELEGATE-CHAIN-TOO-DEEP");
  });

  it("rejects empty DAG", () => {
    const r = validateDag({ nodes: [], edges: [] });
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NOP-TASK-DAG-INVALID");
  });

  it("rejects duplicate node IDs", () => {
    const dag: TaskDag = {
      nodes: [makeNode("a"), makeNode("a")],
      edges: [],
    };
    const r = validateDag(dag);
    expect(r.valid).toBe(false);
    expect(r.errorCode).toBe("NOP-TASK-DAG-INVALID");
  });
});

// ── NopOrchestrator — execution engine ───────────────────────────────────────

describe("NopOrchestrator", () => {

  it("executes a single-node DAG and returns COMPLETED", async () => {
    const dag  = { nodes: [makeNode("n1")], edges: [] };
    const disp = okDispatcher({ data: "hello" });
    const orch = new NopOrchestrator(disp, new InMemoryNopTaskStore());
    const res  = await orch.execute(makeTaskFrame(dag));

    expect(res.state).toBe(TaskState.COMPLETED);
    expect(res.nodeResults["n1"].ok).toBe(true);
    expect(disp.dispatch).toHaveBeenCalledOnce();
  });

  it("executes a linear chain in topological order", async () => {
    const callOrder: string[] = [];
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId): Promise<NodeResult> => {
        callOrder.push(nodeId);
        return { nodeId, ok: true, output: { from: nodeId } };
      }),
    };
    const dag: TaskDag = {
      nodes: [
        makeNode("a"),
        makeNode("b", { inputFrom: ["a"] }),
        makeNode("c", { inputFrom: ["b"] }),
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    };
    const res = await new NopOrchestrator(disp).execute(makeTaskFrame(dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(callOrder).toEqual(["a", "b", "c"]);
  });

  it("fails the whole task when a node fails after retries", async () => {
    const dag  = { nodes: [makeNode("a")], edges: [] };
    const disp = failDispatcher();
    const orch = new NopOrchestrator(disp, new InMemoryNopTaskStore());
    const res  = await orch.execute(makeTaskFrame(dag));

    expect(res.state).toBe(TaskState.FAILED);
    // A failed end node fails the task with NOP-SYNC-DEPENDENCY-FAILED (.NET parity).
    expect(res.error?.code).toBe("NOP-SYNC-DEPENDENCY-FAILED");
    // maxRetries=2 → 3 total attempts
    expect(disp.dispatch).toHaveBeenCalledTimes(3);
  });

  it("retries once on failure then succeeds", async () => {
    let calls = 0;
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId): Promise<NodeResult> => {
        calls++;
        if (calls < 2) return { nodeId, ok: false, error: { code: "TEMP", message: "transient" } };
        return { nodeId, ok: true, output: { fixed: true } };
      }),
    };
    const dag = { nodes: [makeNode("n")], edges: [] };
    const res = await new NopOrchestrator(disp).execute(makeTaskFrame(dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(calls).toBe(2);
  });

  it("does not execute the same task_id twice", async () => {
    const dag   = { nodes: [makeNode("a")], edges: [] };
    const disp  = okDispatcher();
    const store = new InMemoryNopTaskStore();
    const orch  = new NopOrchestrator(disp, store);
    const frame = makeTaskFrame(dag);
    await orch.execute(frame);
    const res2  = await orch.execute(frame);
    expect(res2.state).toBe(TaskState.FAILED);
    expect(res2.error?.code).toBe("NOP-TASK-ALREADY-COMPLETED");
    expect(disp.dispatch).toHaveBeenCalledOnce();
  });

  it("executes diamond fan-out in parallel-safe topological order", async () => {
    const callOrder: string[] = [];
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId): Promise<NodeResult> => {
        callOrder.push(nodeId);
        return { nodeId, ok: true, output: { from: nodeId } };
      }),
    };
    const dag: TaskDag = {
      nodes: [
        makeNode("fetch"),
        makeNode("a", { inputFrom: ["fetch"] }),
        makeNode("b", { inputFrom: ["fetch"] }),
        makeNode("merge", { inputFrom: ["a", "b"] }),
      ],
      edges: [
        { from: "fetch", to: "a" },
        { from: "fetch", to: "b" },
        { from: "a", to: "merge" },
        { from: "b", to: "merge" },
      ],
    };
    const res = await new NopOrchestrator(disp).execute(makeTaskFrame(dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    // fetch must be first, merge must be last
    expect(callOrder[0]).toBe("fetch");
    expect(callOrder[callOrder.length - 1]).toBe("merge");
  });

  it("passes upstream output as input to downstream node", async () => {
    let capturedParams: unknown;
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId, _node, params): Promise<NodeResult> => {
        if (nodeId === "b") capturedParams = params;
        return { nodeId, ok: true, output: nodeId === "a" ? { value: 42 } : undefined };
      }),
    };
    const dag: TaskDag = {
      nodes: [makeNode("a"), makeNode("b", { inputFrom: ["a"] })],
      edges: [{ from: "a", to: "b" }],
    };
    await new NopOrchestrator(disp).execute(makeTaskFrame(dag));
    expect(capturedParams).toEqual({ value: 42 });
  });

  it("honours AbortSignal — cancels mid-DAG", async () => {
    const controller = new AbortController();
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId): Promise<NodeResult> => {
        controller.abort();
        return { nodeId, ok: true };
      }),
    };
    const dag: TaskDag = {
      nodes: [makeNode("a"), makeNode("b", { inputFrom: ["a"] })],
      edges: [{ from: "a", to: "b" }],
    };
    const res = await new NopOrchestrator(disp).execute(
      makeTaskFrame(dag), controller.signal,
    );
    // a executed + abort → b never ran
    expect(res.state).toBe(TaskState.CANCELLED);
    expect(disp.dispatch).toHaveBeenCalledOnce();
  });

  it("skips a node whose condition evaluates to false", async () => {
    const disp: INopWorkerDispatcher = {
      dispatch: vi.fn(async (nodeId): Promise<NodeResult> => ({
        nodeId, ok: true, output: { status: "skipped-precondition" },
      })),
    };
    const dag: TaskDag = {
      nodes: [
        makeNode("a"),
        makeNode("b", {
          inputFrom: ["a"],
          // condition references a field that won't match → skip
          condition: '$.a.status == "never"',
        }),
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const res = await new NopOrchestrator(disp).execute(makeTaskFrame(dag));
    expect(res.state).toBe(TaskState.COMPLETED);
    expect(res.nodeResults["b"]?.skipped).toBe(true);
    expect(disp.dispatch).toHaveBeenCalledOnce(); // only "a" dispatched
  });
});
