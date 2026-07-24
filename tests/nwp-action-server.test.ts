// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ActionExecutionError,
  ActionNodeApp,
  SYSTEM_TASK_CANCEL,
  SYSTEM_TASK_STATUS,
  type ActionContext,
  type ActionExecutionResult,
  type ActionNodeOptions,
  type IActionNodeProvider,
} from "../src/nwp/action-server.js";
import { ActionFrame } from "../src/nwp/frames.js";
import * as EC from "../src/nwp/nwp-error-codes.js";

const PREFIX = "/orders";
const NODE = "urn:nps:node:api.example.com:orders";
const AGENT = "urn:nps:agent:tester";

function baseOptions(over: Partial<ActionNodeOptions> = {}): ActionNodeOptions {
  return {
    nodeId: NODE,
    pathPrefix: PREFIX,
    actions: {
      "orders.create": { resultAnchor: "nps:orders:result", timeoutMsDefault: 5_000, timeoutMsMax: 10_000 },
      "orders.build": { async: true, timeoutMsDefault: 200 },
    },
    ...over,
  };
}

function req(app: ActionNodeApp, path: string, init?: RequestInit & { agent?: string | null }): Promise<Response> {
  const agent = init?.agent === undefined ? AGENT : init.agent;
  const headers = new Headers(init?.headers);
  if (agent) headers.set("X-NWP-Agent", agent);
  return app.fetch(new Request(`http://action${path}`, { ...init, headers }));
}

/** Provider that echoes params and reports the effective timeout it received. */
class EchoProvider implements IActionNodeProvider {
  public lastCtx: ActionContext | null = null;
  constructor(private readonly behaviour?: (frame: ActionFrame, ctx: ActionContext, signal?: AbortSignal) => Promise<ActionExecutionResult>) {}
  async execute(frame: ActionFrame, ctx: ActionContext, signal?: AbortSignal): Promise<ActionExecutionResult> {
    this.lastCtx = ctx;
    if (this.behaviour) return this.behaviour(frame, ctx, signal);
    return { result: { echo: frame.params ?? null, action: frame.actionId }, tokenEst: 3 };
  }
}

function post(actionId: string, extra: Record<string, unknown> = {}): RequestInit {
  return { method: "POST", body: JSON.stringify({ action_id: actionId, ...extra }) };
}

describe("action-server: manifest & registry", () => {
  it("nwm basic shape", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions({ displayName: "Orders" }));
    const r = await req(app, `${PREFIX}/.nwm`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/nwp-manifest+json");
    expect(r.headers.get("x-nwp-node-type")).toBe("action");
    const m = await r.json();
    expect(m.nwp).toBe("0.4");
    expect(m.node_type).toBe("action");
    expect(m.endpoints).toEqual({ invoke: `${PREFIX}/invoke`, schema: `${PREFIX}/.schema` });
    expect(m.capabilities.query).toBe(false);
  });

  it("/actions and /.schema expose the registry", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    for (const p of ["/actions", "/.schema"]) {
      const body = await (await req(app, `${PREFIX}${p}`)).json();
      expect(body.actions["orders.create"].async).toBe(false);
      expect(body.actions["orders.build"].async).toBe(true);
    }
  });

  it("registering a reserved action id throws", () => {
    expect(() => new ActionNodeApp(new EchoProvider(), baseOptions({
      actions: { [SYSTEM_TASK_STATUS]: {} },
    }))).toThrow(/Reserved action ids/);
  });
});

describe("action-server: sync invoke", () => {
  it("returns a caps frame with data", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { params: { x: 1 }, request_id: "rq-1" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/nwp-capsule");
    expect(r.headers.get("x-nwp-node-type")).toBe("action");
    expect(r.headers.get("x-nwp-schema")).toBe("nps:orders:result");
    expect(r.headers.get("x-nwp-request-id")).toBe("rq-1");
    const body = await r.json();
    expect(body.count).toBe(1);
    expect(body.data[0].echo).toEqual({ x: 1 });
    expect(body.anchor_ref).toBe("nps:orders:result");
  });

  it("unknown action → 404", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("nope.verb"));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_NOT_FOUND);
  });

  it("invalid priority → 400", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { priority: "urgent" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("async on a sync-only action → 400", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { async: true }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("provider ActionExecutionError controls the wire status", async () => {
    const app = new ActionNodeApp(new EchoProvider(async () => {
      throw new ActionExecutionError(422, "NPS-CLIENT-UNPROCESSABLE", EC.NWP_ACTION_PARAMS_INVALID, "bad params");
    }), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create"));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("method not allowed → 405", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    expect((await req(app, `${PREFIX}/invoke`)).status).toBe(405);
  });
});

describe("action-server: timeout clamping", () => {
  it("clamps requested timeout to the spec/option max", async () => {
    const provider = new EchoProvider();
    const app = new ActionNodeApp(provider, baseOptions());
    // orders.create has timeoutMsMax 10_000; request 999_999 → clamped.
    await req(app, `${PREFIX}/invoke`, post("orders.create", { timeout_ms: 999_999 }));
    expect(provider.lastCtx!.timeoutMs).toBe(10_000);
  });

  it("applies spec default when timeout absent", async () => {
    const provider = new EchoProvider();
    const app = new ActionNodeApp(provider, baseOptions());
    await req(app, `${PREFIX}/invoke`, post("orders.create"));
    expect(provider.lastCtx!.timeoutMs).toBe(5_000);
  });

  it("sync execution timeout → 504", async () => {
    const app = new ActionNodeApp(new EchoProvider(async (_f, _c, signal) => {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { result: {} };
    }), baseOptions({
      actions: { "orders.slow": { timeoutMsDefault: 20 } },
    }));
    const r = await req(app, `${PREFIX}/invoke`, post("orders.slow"));
    expect(r.status).toBe(504);
    expect((await r.json()).status).toBe("NPS-SERVER-TIMEOUT");
  });
});

describe("action-server: callback SSRF", () => {
  it("rejects a loopback https callback", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { callback_url: "https://127.0.0.1/cb" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("rejects a non-https callback", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { callback_url: "http://example.com/cb" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("accepts a public https callback", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { callback_url: "https://hooks.example.com/cb" }));
    expect(r.status).toBe(200);
  });
});

describe("action-server: idempotency", () => {
  it("sync re-hit returns the cached result", async () => {
    let calls = 0;
    const app = new ActionNodeApp(new EchoProvider(async () => {
      calls++;
      return { result: { n: calls }, anchorRef: "nps:orders:result" };
    }), baseOptions());
    const body = { params: { x: 1 }, idempotency_key: "k1" };
    const r1 = await (await req(app, `${PREFIX}/invoke`, post("orders.create", body))).json();
    const r2 = await (await req(app, `${PREFIX}/invoke`, post("orders.create", body))).json();
    expect(calls).toBe(1);
    expect(r1.data[0].n).toBe(1);
    expect(r2.data[0].n).toBe(1);
  });

  it("same key + different params → 409 conflict", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    await req(app, `${PREFIX}/invoke`, post("orders.create", { params: { x: 1 }, idempotency_key: "k2" }));
    const r = await req(app, `${PREFIX}/invoke`, post("orders.create", { params: { x: 2 }, idempotency_key: "k2" }));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_IDEMPOTENCY_CONFLICT);
  });

  it("async re-hit returns the same task handle", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const body = { async: true, params: { j: 1 }, idempotency_key: "kA" };
    const r1 = await (await req(app, `${PREFIX}/invoke`, post("orders.build", body))).json();
    const resp2 = await req(app, `${PREFIX}/invoke`, post("orders.build", body));
    const r2 = await resp2.json();
    expect(resp2.status).toBe(202);
    expect(r2.task_id).toBe(r1.task_id);
  });
});

describe("action-server: async + reserved system.task.*", () => {
  it("async invoke returns 202 pending then completes and is queryable", async () => {
    let resolveExec!: (v: ActionExecutionResult) => void;
    const app = new ActionNodeApp(new EchoProvider(() => new Promise<ActionExecutionResult>((res) => { resolveExec = res; })),
      baseOptions());
    const accepted = await req(app, `${PREFIX}/invoke`, post("orders.build", { async: true, request_id: "rq-9" }));
    expect(accepted.status).toBe(202);
    const acc = await accepted.json();
    expect(acc.status).toBe("pending");
    expect(acc.poll_url).toBe(`${PREFIX}/invoke`);
    expect(acc.request_id).toBe("rq-9");
    const taskId = acc.task_id as string;

    // status while running/pending
    const statusReq = () => req(app, `${PREFIX}/invoke`, post(SYSTEM_TASK_STATUS, { params: { task_id: taskId } }));
    let st = await (await statusReq()).json();
    expect(["pending", "running"]).toContain(st.data[0].status);

    resolveExec({ result: { done: true } });
    await new Promise((r) => setTimeout(r, 5));

    st = await (await statusReq()).json();
    expect(st.data[0].status).toBe("completed");
    expect(st.data[0].result).toEqual({ done: true });
  });

  it("task.status for unknown id → 404", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post(SYSTEM_TASK_STATUS, { params: { task_id: "missing" } }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe(EC.NWP_TASK_NOT_FOUND);
  });

  it("task.status without task_id → 400", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    const r = await req(app, `${PREFIX}/invoke`, post(SYSTEM_TASK_STATUS, { params: {} }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe(EC.NWP_ACTION_PARAMS_INVALID);
  });

  it("task.cancel transitions a running task", async () => {
    const app = new ActionNodeApp(new EchoProvider(() => new Promise<ActionExecutionResult>(() => { /* never */ })),
      baseOptions());
    const acc = await (await req(app, `${PREFIX}/invoke`, post("orders.build", { async: true }))).json();
    const taskId = acc.task_id as string;
    const c = await req(app, `${PREFIX}/invoke`, post(SYSTEM_TASK_CANCEL, { params: { task_id: taskId } }));
    expect(c.status).toBe(200);
    expect((await c.json()).data[0].status).toBe("cancelled");
    // second cancel on terminal state → 409
    const again = await req(app, `${PREFIX}/invoke`, post(SYSTEM_TASK_CANCEL, { params: { task_id: taskId } }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe(EC.NWP_TASK_ALREADY_CANCELLED);
  });
});

describe("action-server: auth", () => {
  it("requireAuth rejects missing agent with 401", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions({ requireAuth: true }));
    const r = await req(app, `${PREFIX}/.nwm`, { agent: null });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe(EC.NWP_AUTH_NID_SCOPE_VIOLATION);
  });

  it("unknown path → 404", async () => {
    const app = new ActionNodeApp(new EchoProvider(), baseOptions());
    expect((await req(app, `${PREFIX}/nope`)).status).toBe(404);
  });
});
