// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { StreamFrame } from "../src/ncp/frames.js";
import {
  ActionExecutionError,
  ActionNodeApp,
  SYSTEM_TASK_CANCEL,
  SYSTEM_TASK_STATUS,
  type ActionExecutionResult,
  type ActionContext,
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
    private readonly behavior?: (
      frame: ActionFrame,
      signal?: AbortSignal,
    ) => Promise<ActionExecutionResult>,
  ) {}

  async execute(frame: ActionFrame, context: ActionContext, signal?: AbortSignal): Promise<ActionExecutionResult> {
    this.calls++;
    if (this.behavior) return this.behavior(frame, signal);
    return {
      result: {
        stop_reason: "end_turn",
        content: "First",
        usage: { input_tokens: 12, output_tokens: 2, wire_input_bytes: context.wireInputBytes },
      },
    };
  }
}

function createTest(
  provider = new LlmProvider(),
  configure?: (options: {
    supportsTools: boolean;
    supportsStream: boolean;
    authorizer?: (
      owner: { nid: string; securityScope: string },
      actionId: string,
      stage: LlmAuthorizationStage,
      requiredCapabilities: readonly string[],
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
  const llmOptions = {
    securityScope: "workspace-a",
    runtimeRevision: "runtime-1",
    supportsTools: false,
    supportsStream: true,
    authorizer: async () => {},
  };
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

async function streamFrames(response: Response): Promise<Record<string, unknown>[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  return (await response.text()).split("\n").filter(Boolean).map(
    line => JSON.parse(line) as Record<string, unknown>);
}

async function* completionStream(abnormal = false): AsyncGenerator<StreamFrame> {
  yield new StreamFrame("provider", 0, false, [{ content_delta: "Fir" }],
    "nps:system:llm.complete:stream");
  await Promise.resolve();
  if (abnormal) return;
  yield new StreamFrame("provider", 1, true, [{
    content_delta: "st",
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 1 },
  }]);
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
      supports_stream: true,
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

  it("recovers after reconnect, serializes concurrent appends, and loses process state on restart", async () => {
    let markStarted!: () => void;
    let releaseWinner!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseWinner = resolve; });
    const provider = new LlmProvider(async frame => {
      const context = (frame.params as Record<string, unknown>).context as Record<string, unknown>;
      if (context.operation === "append") {
        markStarted();
        await gate;
      }
      return { result: { stop_reason: "end_turn", content: "First" } };
    });
    const test = createTest(provider);

    // Discard the create body and recover it through a logically new connection.
    expect((await invoke(test.app, LLM_COMPLETE, createParams(), { key: "lost-create" })).status)
      .toBe(200);
    const recovered = await data(await invoke(
      test.app, LLM_CONTEXT_STATUS, { idempotency_key: "lost-create" }));
    expect(recovered).toMatchObject({ state: "active", version: 1 });
    const contextId = recovered.context_id as string;
    const append = {
      kind: LLM_COMPLETE,
      model: "willow-small",
      messages: [{ role: "user", content: "Two" }],
      context: { operation: "append", context_id: contextId, base_version: 1 },
    };
    const winnerPromise = invoke(test.app, LLM_COMPLETE, append, { key: "append-winner" });
    await started;
    const loser = await invoke(test.app, LLM_COMPLETE, append, { key: "append-loser" });
    expect(loser.status).toBe(409);
    expect((await loser.json()).error).toBe(EC.NWP_LLM_CONTEXT_VERSION_CONFLICT);
    releaseWinner();
    const winner = await data(await winnerPromise);
    expect((winner.context as Record<string, unknown>).version).toBe(2);
    expect(provider.calls).toBe(2);

    const restarted = createTest();
    append.context.base_version = 2;
    const missing = await invoke(
      restarted.app, LLM_COMPLETE, append, { key: "append-after-restart" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe(EC.NWP_LLM_CONTEXT_NOT_FOUND);
    expect(restarted.provider.calls).toBe(0);
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
    const streamAsync = await invoke(test.app, LLM_COMPLETE, {
      ...createParams(), stream: true,
    }, { key: "stream-async", async: true });
    expect(streamAsync.status).toBe(422);
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

  it("commits a stream at terminal and replays it under a fresh stream id", async () => {
    const provider = new LlmProvider(async frame => frame.params?.["stream"] === true
      ? { streamFrames: completionStream() }
      : { result: { stop_reason: "end_turn", content: "First" } });
    const test = createTest(provider);
    const params = { ...createParams(), stream: true };
    const first = await streamFrames(await invoke(
      test.app, LLM_COMPLETE, params, { key: "stream-create" }));
    const replay = await streamFrames(await invoke(
      test.app, LLM_COMPLETE, params, { key: "stream-create" }));

    expect(first.map(frame => frame.is_last)).toEqual([false, true]);
    expect(first[0]!.stream_id).not.toBe(replay[0]!.stream_id);
    const firstChunk = (first[0]!.data as Record<string, unknown>[])[0]!;
    const terminal = (first[1]!.data as Record<string, unknown>[])[0]!;
    const replayTerminal = (replay[1]!.data as Record<string, unknown>[])[0]!;
    expect(firstChunk).toMatchObject({ content_delta: "Fir" });
    expect(firstChunk.context).toBeUndefined();
    expect(terminal).toMatchObject({ content_delta: "st", stop_reason: "end_turn" });
    expect(terminal.context).toEqual(replayTerminal.context);
    expect((terminal.context as Record<string, unknown>).version).toBe(1);
    expect(provider.calls).toBe(1);
    const contextId = (terminal.context as Record<string, unknown>).context_id as string;
    expect(test.store.snapshot(
      { nid: ALICE, securityScope: "workspace-a" }, contextId).transcript.at(-1)?.content)
      .toBe("First");
  });

  it("aborts a stream that ends without a terminal frame", async () => {
    const provider = new LlmProvider(async () => ({
      streamFrames: completionStream(true),
    }));
    const test = createTest(provider);
    const frames = await streamFrames(await invoke(test.app, LLM_COMPLETE, {
      ...createParams(), stream: true,
    }, { key: "stream-abnormal" }));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ is_last: true, error_code: EC.NWP_NODE_UNAVAILABLE });
    const status = await data(await invoke(
      test.app, LLM_CONTEXT_STATUS, { idempotency_key: "stream-abnormal" }));
    expect(status).toMatchObject({ state: "failed" });
    expect(status.context_id).toBeUndefined();
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

  it("passes exact capability sets and fails closed without an authorizer", async () => {
    const checks: string[][] = [];
    const test = createTest(new LlmProvider(), options => {
      options.authorizer = async (_owner, _action, _stage, required) => {
        checks.push([...required]);
      };
    });

    expect((await invoke(test.app, LLM_COMPLETE, createParams(), { key: "capabilities" })).status)
      .toBe(200);
    expect((await invoke(test.app, LLM_CONTEXT_STATUS, { idempotency_key: "capabilities" })).status)
      .toBe(200);
    expect((await invoke(test.app, LLM_COMPLETE, {
      ...createParams(), stream: true, tools: [{ name: "lookup" }],
    }, { key: "extended-capabilities" })).status).toBe(422);
    expect(checks).toEqual([
      ["llm:complete", "llm:context"],
      ["llm:complete", "llm:context"],
      ["llm:context"],
      ["llm:complete", "llm:context", "llm:stream", "llm:tool_call"],
    ]);

    const deniedTest = createTest(new LlmProvider(), options => { delete options.authorizer; });
    const denied = await invoke(
      deniedTest.app, LLM_COMPLETE, createParams(), { key: "no-authorizer" });
    expect(denied.status).toBe(403);
    expect((await denied.json() as Record<string, unknown>).error).toBe(EC.NWP_LLM_CONTEXT_FORBIDDEN);
    expect(deniedTest.provider.calls).toBe(0);
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
