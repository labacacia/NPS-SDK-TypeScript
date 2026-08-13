// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ActionExecutionError,
  ActionNodeApp,
  SYSTEM_TASK_CANCEL,
  SYSTEM_TASK_STATUS,
  type ActionExecutionResult,
  type ActionNodeOptions,
  type IActionNodeProvider,
} from "../src/nwp/action-server.js";
import { InMemoryLlmContextStore } from "../src/nwp/context-store.js";
import type { ActionFrame } from "../src/nwp/frames.js";
import {
  StatefulLlmActionProvider,
  type LlmAuthorizationStage,
} from "../src/nwp/llm-action-server.js";
import {
  LLM_COMPLETE,
  LLM_COMPLETE_RESPONSE_ANCHOR,
  LLM_CONTEXT_RELEASE,
  LLM_CONTEXT_STATUS,
} from "../src/nwp/llm.js";
import * as EC from "../src/nwp/nwp-error-codes.js";

const PREFIX = "/llm";
const ALICE = "urn:nps:agent:labacacia:alice";
const BOB = "urn:nps:agent:labacacia:bob";

class LlmProvider implements IActionNodeProvider {
  calls = 0;
  constructor(
    private readonly behavior: (
      frame: ActionFrame,
      signal?: AbortSignal,
    ) => Promise<ActionExecutionResult> = async () => ({
      result: {
        stop_reason: "end_turn",
        content: "First",
        usage: { input_tokens: 12, output_tokens: 2, wire_input_bytes: 128 },
      },
    }),
  ) {}

  async execute(frame: ActionFrame, _context: unknown, signal?: AbortSignal): Promise<ActionExecutionResult> {
    this.calls++;
    return this.behavior(frame, signal);
  }
}

function createTest(
  provider = new LlmProvider(),
  configure?: (options: {
    supportsTools: boolean;
    authorizer?: (
      owner: { nid: string; securityScope: string },
      actionId: string,
      stage: LlmAuthorizationStage,
    ) => Promise<void> | void;
  }) => void,
) {
  const ids = [
    "AQIDBAUGBwgJCgsMDQ4PEA",
    "ERITFBUWFxgZGhscHR4fIA",
    "ISIjJCUmJygpKissLS4vMA",
    "MTIzNDU2Nzg5Ojs8PT4_QA",
  ];
  const store = new InMemoryLlmContextStore({
    contextIdFactory: () => ids.shift() ?? "QUJDREVGR0hJSktMTU5PUA",
  });
  const llmOptions = { securityScope: "workspace-a", runtimeRevision: "runtime-1", supportsTools: false };
  configure?.(llmOptions);
  const coordinator = new StatefulLlmActionProvider(provider, store, llmOptions);
  const node: ActionNodeOptions = {
    nodeId: "urn:nps:node:labacacia:llm",
    pathPrefix: PREFIX,
    requireAuth: true,
    actions: {},
  };
  coordinator.configureNode(node);
  return { app: new ActionNodeApp(coordinator, node), coordinator, provider, store };
}

function invoke(
  app: ActionNodeApp,
  actionId: string,
  params: Record<string, unknown>,
  options: { agent?: string; key?: string; async?: boolean } = {},
): Promise<Response> {
  return app.fetch(new Request(`http://llm${PREFIX}/invoke`, {
    method: "POST",
    headers: { "X-NWP-Agent": options.agent ?? ALICE },
    body: JSON.stringify({
      action_id: actionId,
      params,
      idempotency_key: options.key,
      async: options.async ?? false,
      request_id: `req-${options.key ?? "none"}`,
    }),
  }));
}

function createParams(content = "One"): Record<string, unknown> {
  return {
    kind: LLM_COMPLETE,
    model: "willow-small",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content },
    ],
    context: { operation: "create" },
  };
}

async function data(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as { data: Record<string, unknown>[] };
  return body.data[0]!;
}

describe("stateful LLM Action Server", () => {
  it("advertises the exact process-local NWM 0.2 profile and actions", async () => {
    const { app } = createTest();
    const manifest = await (await app.fetch(new Request(`http://llm${PREFIX}/.nwm`, {
      headers: { "X-NWP-Agent": ALICE },
    }))).json();
    expect(manifest.profiles.llm).toMatchObject({
      profile_version: "0.2",
      actions: [LLM_COMPLETE, LLM_CONTEXT_STATUS, LLM_CONTEXT_RELEASE],
      supports_stream: false,
      context: {
        supported: true,
        operations: ["create", "append", "fork", "reset", "release"],
        persistence: "process",
        max_contexts_per_principal: 32,
      },
    });
    const registry = await (await app.fetch(new Request(`http://llm${PREFIX}/actions`, {
      headers: { "X-NWP-Agent": ALICE },
    }))).json();
    expect(registry.actions[LLM_COMPLETE].result_anchor).toBe(LLM_COMPLETE_RESPONSE_ANCHOR);
    expect(registry.actions[LLM_CONTEXT_STATUS].async).toBe(false);
  });

  it("creates, appends, inspects, and releases an official context", async () => {
    const { app, store } = createTest();
    const createdResponse = await invoke(app, LLM_COMPLETE, createParams(), { key: "create-1" });
    expect(createdResponse.status).toBe(200);
    expect(createdResponse.headers.get("x-nwp-schema")).toBe(LLM_COMPLETE_RESPONSE_ANCHOR);
    const created = await data(createdResponse);
    const receipt = created.context as Record<string, unknown>;
    expect(receipt).toMatchObject({ version: 1, operation: "create", state: "active" });
    const contextId = receipt.context_id as string;

    const appended = await data(await invoke(app, LLM_COMPLETE, {
      kind: LLM_COMPLETE,
      model: "willow-small",
      messages: [{ role: "user", content: "Two" }],
      context: { operation: "append", context_id: contextId, base_version: 1 },
    }, { key: "append-1" }));
    expect((appended.context as Record<string, unknown>).version).toBe(2);
    expect(store.snapshot({ nid: ALICE, securityScope: "workspace-a" }, contextId).transcript).toHaveLength(5);

    const status = await data(await invoke(app, LLM_CONTEXT_STATUS, { context_id: contextId }));
    expect(status).toMatchObject({ state: "active", context_id: contextId, version: 2 });
    const released = await data(await invoke(app, LLM_CONTEXT_RELEASE, {
      context_id: contextId, base_version: 2,
    }, { key: "release-1" }));
    expect(released).toMatchObject({ state: "released", version: 3 });
  });

  it("rejects malformed requests and unsupported tools before provider execution", async () => {
    const test = createTest();
    const malformed = await invoke(test.app, LLM_COMPLETE, {
      model: "", messages: [], context: { operation: "create" },
    }, { key: "bad" });
    expect(malformed.status).toBe(422);
    const tools = await invoke(test.app, LLM_COMPLETE, {
      ...createParams(), tools: [{ name: "search" }],
    }, { key: "tools" });
    expect(tools.status).toBe(422);
    const resetWithoutVersion = await invoke(test.app, LLM_COMPLETE, {
      ...createParams(), context: { operation: "reset" },
    }, { key: "reset-without-version" });
    expect(resetWithoutVersion.status).toBe(422);
    expect(test.provider.calls).toBe(0);
  });

  it("aborts provider and model errors without allocating a context", async () => {
    for (const [name, provider, expectedStatus] of [
      ["provider", new LlmProvider(async () => { throw new Error("down"); }), 500],
      ["model", new LlmProvider(async () => ({ result: { stop_reason: "error", error: "refused" } })), 200],
    ] as const) {
      const test = createTest(provider);
      expect((await invoke(test.app, LLM_COMPLETE, createParams(), { key: name })).status)
        .toBe(expectedStatus);
      const status = await data(await invoke(test.app, LLM_CONTEXT_STATUS, { idempotency_key: name }));
      expect(status.state).toBe("failed");
      expect(status.context_id).toBeUndefined();
    }
  });

  it("reauthorizes at commit and aborts a revoked mutation", async () => {
    const test = createTest(new LlmProvider(), options => {
      options.authorizer = async (_owner, _action, stage) => {
        if (stage === "commit") {
          throw new ActionExecutionError(401, "NPS-AUTH-UNAUTHENTICATED",
            EC.NWP_AUTH_NID_REVOKED, "revoked before commit");
        }
      };
    });
    const response = await invoke(test.app, LLM_COMPLETE, createParams(), { key: "revoked" });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe(EC.NWP_AUTH_NID_REVOKED);
    const status = await data(await invoke(test.app, LLM_CONTEXT_STATUS, { idempotency_key: "revoked" }));
    expect(status).toMatchObject({ state: "failed", error_code: EC.NWP_AUTH_NID_REVOKED });
  });

  it("keeps response idempotency and task access caller scoped", async () => {
    const test = createTest();
    const alice = await data(await invoke(test.app, LLM_COMPLETE, createParams(), { key: "shared" }));
    const replay = await data(await invoke(test.app, LLM_COMPLETE, createParams(), { key: "shared" }));
    const bob = await data(await invoke(test.app, LLM_COMPLETE, createParams(), { key: "shared", agent: BOB }));
    expect((replay.context as Record<string, unknown>).context_id)
      .toBe((alice.context as Record<string, unknown>).context_id);
    expect((bob.context as Record<string, unknown>).context_id).not
      .toBe((alice.context as Record<string, unknown>).context_id);
    expect(test.provider.calls).toBe(2);
  });

  it("puts the context receipt only in the terminal async task result", async () => {
    const test = createTest();
    const accepted = await invoke(test.app, LLM_COMPLETE, createParams(), { key: "async", async: true });
    expect(accepted.status).toBe(202);
    const ack = await accepted.json();
    expect(ack.context).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 5));
    const task = await data(await invoke(test.app, SYSTEM_TASK_STATUS, { task_id: ack.task_id }));
    expect(task.status).toBe("completed");
    expect((task.result as Record<string, unknown>).context).toMatchObject({ version: 1 });
    const bob = await invoke(test.app, SYSTEM_TASK_STATUS, { task_id: ack.task_id }, { agent: BOB });
    expect(bob.status).toBe(403);
  });

  it("aborts a reservation when cancellation wins even if the provider ignores the signal", async () => {
    let finish!: () => void;
    const provider = new LlmProvider(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { result: { stop_reason: "end_turn", content: "too late" } };
    });
    const test = createTest(provider);
    const accepted = await invoke(test.app, LLM_COMPLETE, createParams(), { key: "cancel", async: true });
    const ack = await accepted.json();
    expect((await invoke(test.app, SYSTEM_TASK_CANCEL, { task_id: ack.task_id })).status).toBe(200);
    finish();
    await new Promise(resolve => setTimeout(resolve, 5));
    const status = await data(await invoke(test.app, LLM_CONTEXT_STATUS, { idempotency_key: "cancel" }));
    expect(status.state).toBe("failed");
    expect(status.context_id).toBeUndefined();
  });
});
