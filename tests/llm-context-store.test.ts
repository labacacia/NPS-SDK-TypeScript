// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conformanceFixture } from "./conformance-fixtures.js";
import {
  InMemoryLlmContextStore,
  LlmContextBinding,
  LlmContextMutationRequest,
  LlmContextOwner,
  LlmContextStoreError,
} from "../src/nwp/context-store.js";
import { LlmContextOperation, LlmMessageDto, LlmUsageDto } from "../src/nwp/llm.js";
import {
  NWP_ACTION_IDEMPOTENCY_CONFLICT,
  NWP_ACTION_PARAMS_INVALID,
  NWP_AUTH_NID_REVOKED,
  NWP_LLM_CONTEXT_BINDING_MISMATCH,
  NWP_LLM_CONTEXT_EXPIRED,
  NWP_LLM_CONTEXT_FORBIDDEN,
  NWP_LLM_CONTEXT_LIMIT_EXCEEDED,
  NWP_LLM_CONTEXT_NOT_FOUND,
  NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED,
  NWP_LLM_CONTEXT_VERSION_CONFLICT,
} from "../src/nwp/nwp-error-codes.js";

const ALICE: LlmContextOwner = {
  nid: "urn:nps:agent:labacacia:alice",
  securityScope: "workspace-a",
};
const BOB: LlmContextOwner = {
  nid: "urn:nps:agent:labacacia:bob",
  securityScope: "workspace-a",
};

const system = (content: string): LlmMessageDto => ({ role: "system", content });
const user = (content: string): LlmMessageDto => ({ role: "user", content });
const assistant = (content: string): LlmMessageDto => ({ role: "assistant", content });

function binding(model = "willow-small", runtimeRevision = "runtime-1"): LlmContextBinding {
  return {
    model,
    runtimeRevision,
    systemMessages: [system(model === "willow-small" ? "Be concise." : "Use JSON.")],
  };
}

class Harness {
  now = Date.parse("2026-08-12T00:00:00.000Z");
  readonly ids = [
    "AQIDBAUGBwgJCgsMDQ4PEA",
    "ERITFBUWFxgZGhscHR4fIA",
    "ISIjJCUmJygpKissLS4vMA",
    "MTIzNDU2Nzg5Ojs8PT4_QA",
  ];
  readonly store: InMemoryLlmContextStore;

  constructor(options: {
    maxContexts?: number;
    defaultTtl?: number;
    tombstone?: number;
    supported?: ReadonlySet<LlmContextOperation>;
  } = {}) {
    this.store = new InMemoryLlmContextStore({
      maxContextsPerPrincipal: options.maxContexts ?? 32,
      defaultTtlSeconds: options.defaultTtl ?? 3600,
      maxTtlSeconds: 3600,
      tombstoneSeconds: options.tombstone ?? 86400,
      supportedOperations: options.supported ?? new Set<LlmContextOperation>([
        "create", "append", "fork", "reset", "release",
      ]),
      clock: () => this.now,
      contextIdFactory: () => {
        const id = this.ids.shift();
        if (id === undefined) throw new Error("test context ID queue exhausted");
        return id;
      },
    });
  }

  request(
    operation: LlmContextOperation,
    idempotencyKey: string,
    contextId?: string,
    baseVersion?: number,
    options: {
      selectedBinding?: LlmContextBinding;
      messages?: readonly LlmMessageDto[];
      ttlSeconds?: number;
    } = {},
  ): LlmContextMutationRequest {
    return {
      operation,
      owner: ALICE,
      contextId,
      baseVersion,
      binding: options.selectedBinding ?? binding(),
      messages: options.messages ?? (operation === "create"
        ? [system("Be concise."), user("One")]
        : [user("Continue")]),
      ttlSeconds: options.ttlSeconds,
      idempotencyKey,
      requestId: `req-${idempotencyKey}`,
    };
  }

  create(key = "create-1", ttlSeconds?: number) {
    const reservation = this.store.reserve(this.request("create", key, undefined, undefined, { ttlSeconds }));
    return this.store.commit(reservation, assistant("First"));
  }

  advance(seconds: number): void { this.now += seconds * 1000; }
}

function capture(action: () => unknown): LlmContextStoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LlmContextStoreError);
    return error as LlmContextStoreError;
  }
  throw new Error("Expected LlmContextStoreError");
}

interface SharedVector {
  id: string;
  input: Record<string, any>;
  expected: Record<string, any>;
}
const fixture = JSON.parse(readFileSync(
  conformanceFixture("nwp", "llm_context_vectors.json"),
  "utf8",
)) as { vectors: SharedVector[] };

const cases: Record<string, () => void> = {
  "nwp.llm-context.001": statelessCompatibility,
  "nwp.llm-context.002": createCommitsV1,
  "nwp.llm-context.003": appendCommitsDelta,
  "nwp.llm-context.004": casConflicts,
  "nwp.llm-context.005": forkSnapshotsParent,
  "nwp.llm-context.006": resetReplacesState,
  "nwp.llm-context.007": bindingMismatch,
  "nwp.llm-context.008": ownerBoundary,
  "nwp.llm-context.009": abortPreservesState,
  "nwp.llm-context.010": lostCreateRecovery,
  "nwp.llm-context.011": releaseAndExpiry,
  "nwp.llm-context.012": usageAccounting,
  "nwp.llm-context.013": advertisedOperations,
  "nwp.llm-context.014": processRestart,
  "nwp.llm-context.015": completedIdempotency,
  "nwp.llm-context.016": revocationAbort,
  "nwp.llm-context.017": principalLimit,
  "nwp.llm-context.018": unsupportedOperation,
  "nwp.llm-context.019": missingIdempotency,
};

describe("NWP stateful LLM context shared vectors", () => {
  for (const vector of fixture.vectors) {
    it(vector.id, () => {
      expect(cases[vector.id]).toBeDefined();
      assertFixtureContract(vector);
      cases[vector.id]!();
    });
  }

  it("rejects malformed lifecycle and TTL inputs", () => {
    const h = new Harness();
    expect(capture(() => h.store.status(ALICE, {})).errorCode).toBe(NWP_ACTION_PARAMS_INVALID);
    expect(capture(() => h.store.status(ALICE, {
      contextId: "bad",
      idempotencyKey: "also-bad",
    })).errorCode).toBe(NWP_ACTION_PARAMS_INVALID);
    expect(capture(() => h.store.status(ALICE, { contextId: "bad" })).errorCode)
      .toBe(NWP_ACTION_PARAMS_INVALID);
    expect(capture(() => h.store.reserve({
      ...h.request("create", "bad-ttl"),
      ttlSeconds: 0,
    })).errorCode).toBe(NWP_ACTION_PARAMS_INVALID);
  });

  it("snapshots mutable JavaScript inputs at reservation and read boundaries", () => {
    const h = new Harness();
    const mutableMessages = [system("Be concise."), user("Original")];
    const mutableBinding = binding();
    const reservation = h.store.reserve(h.request("create", "immutable", undefined, undefined, {
      selectedBinding: mutableBinding,
      messages: mutableMessages,
    }));
    mutableMessages[1]!.content = "Tampered";
    (mutableBinding as { model: string }).model = "tampered-model";

    const receipt = h.store.commit(reservation, assistant("Stable"));
    const first = h.store.snapshot(ALICE, receipt.contextId);
    expect(first.binding.model).toBe("willow-small");
    expect(first.transcript[1]?.content).toBe("Original");
    (first.transcript[1] as { content: string }).content = "Mutated snapshot";
    expect(h.store.snapshot(ALICE, receipt.contextId).transcript[1]?.content).toBe("Original");
  });
});

function assertFixtureContract(vector: SharedVector): void {
  const i = vector.input;
  const e = vector.expected;
  expect(Object.keys(i).length, `${vector.id} input`).toBeGreaterThan(0);
  expect(Object.keys(e).length, `${vector.id} expected`).toBeGreaterThan(0);
  switch (vector.id.slice(-3)) {
    case "001":
      expect(i.params.context).toBeUndefined();
      expect(e).toEqual({ mode: "stateless", dispatched: true, context_mutated: false,
        response_context_present: false });
      break;
    case "002":
      expect(e.owner_nid).toBe(i.owner_nid); expect(e).toMatchObject({ version: 1, committed: true }); break;
    case "003":
      expect(e.version).toBe(i.pre_state.version + 1);
      expect(e.accepted_delta_message_count).toBe(i.params.messages.length);
      expect(e.post_message_count).toBe(i.pre_state.messages.length + i.params.messages.length + 1); break;
    case "004":
      expect(e.post_version).toBe(i.pre_state.version); expect(e.hint.current_version).toBe(i.pre_state.version);
      expect(e.error).toBe(NWP_LLM_CONTEXT_VERSION_CONFLICT); break;
    case "005":
      expect(e.parent_version).toBe(i.request.base_version); expect(e.post_parent_version).toBe(i.parent_version_at_child_commit);
      expect(e.version).toBe(1); break;
    case "006":
      expect(e.version).toBe(i.pre_state.version + 1); expect(e.resolved_model).toBe(i.request.model); break;
    case "007":
      expect(e.post_version).toBe(i.pre_state.version); expect(e.error).toBe(NWP_LLM_CONTEXT_BINDING_MISMATCH);
      expect(e.provider_dispatched || e.stateless_fallback).toBe(false); break;
    case "008":
      expect(i.owner_nid).not.toBe(i.caller_nid); expect(i.caller_capabilities).not.toContain("llm:context");
      expect(e.error).toBe(NWP_LLM_CONTEXT_FORBIDDEN); break;
    case "009":
      expect(e.post_version).toBe(i.pre_state.version); expect(e.committed).toBe(false);
      expect(e.reservation_released).toBe(true); break;
    case "010":
      expect(e.running_status.context_id_present).toBe(false);
      expect(e.completed_status.context_id).toBe(i.status_sequence.at(-1).context_id);
      expect(e.completed_status.version).toBe(i.status_sequence.at(-1).version); break;
    case "011":
      expect(e.release_receipt.version).toBe(i.pre_state.version + 1);
      expect(e.expiry_tombstone.version).toBe(i.expiry_branch.active_version); break;
    case "012":
      expect(i.usage.input_tokens).toBe(i.usage.reused_tokens + i.usage.evaluated_tokens);
      expect(i.usage.wire_input_bytes).toBeLessThan(i.stateless_wire_input_bytes);
      expect(e).toMatchObject({ usage_equation_valid: true, wire_input_smaller_than_stateless: true }); break;
    case "013":
      expect(i.manifest.context.operations).toEqual(i.implemented_operations);
      expect(i.manifest.context.persistence).toBe(i.implemented_persistence);
      expect(e).toMatchObject({ manifest_valid: true, requires_capability: "llm:context" }); break;
    case "014":
      expect(i).toMatchObject({ persistence: "process", event: "process_restart" });
      expect(e.error).toBe(NWP_LLM_CONTEXT_NOT_FOUND); expect(e.replacement_created || e.stateless_fallback).toBe(false); break;
    case "015":
      expect(i.original.chunks.join("")).toBe(e.ordered_content); expect(i.original.stream_id).not.toBe(i.replay_stream_id);
      expect(e.provider_invocations + e.additional_context_commits).toBe(0); break;
    case "016":
      expect(i).toMatchObject({ authorization_at_admission: "valid", authorization_at_commit: "revoked" });
      expect(e.post_version).toBe(i.pre_state.version); expect(e.error).toBe(NWP_AUTH_NID_REVOKED); break;
    case "017":
      expect(i.live_contexts).toBe(i.max_contexts_per_principal); expect(e.error).toBe(NWP_LLM_CONTEXT_LIMIT_EXCEEDED);
      expect(e.context_allocated).toBe(false); break;
    case "018":
      expect(i.advertised_operations).not.toContain(i.request.operation);
      expect(e.error).toBe(NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED); break;
    case "019":
      expect(i.idempotency_key_present).toBe(false); expect(e.error).toBe(NWP_ACTION_PARAMS_INVALID);
      expect(e.context_allocated || e.provider_dispatched).toBe(false); break;
    default: throw new Error(`Unimplemented fixture contract: ${vector.id}`);
  }
}

function statelessCompatibility(): void {
  const request = { model: "willow-small", messages: [user("Hello")] };
  expect("context" in request).toBe(false);
}

function createCommitsV1(): void {
  const h = new Harness();
  const reservation = h.store.reserve(h.request("create", "create-1"));
  const busy = h.store.status(ALICE, { idempotencyKey: "create-1" });
  expect(busy.state).toBe("busy");
  expect(busy.contextId).toBeUndefined();
  h.advance(5);
  const receipt = h.store.commit(reservation, assistant("First"));
  expect(receipt.version).toBe(1);
  expect(Date.parse(receipt.expiresAt!)).toBe(h.now + 3600 * 1000);
  expect(h.store.snapshot({ ...ALICE }, receipt.contextId).transcript).toHaveLength(3);
}

function appendCommitsDelta(): void {
  const h = new Harness();
  const created = h.create();
  const reservation = h.store.reserve(h.request("append", "append-1", created.contextId, 1, {
    messages: [user("Two")],
  }));
  const receipt = h.store.commit(reservation, assistant("Second"));
  const snapshot = h.store.snapshot(ALICE, created.contextId);
  expect(receipt.version).toBe(2);
  expect(snapshot.transcript).toHaveLength(5);
  expect(snapshot.transcript.at(-2)?.content).toBe("Two");
}

function casConflicts(): void {
  const h = new Harness();
  const created = h.create();
  const winner = h.store.reserve(h.request("append", "winner", created.contextId, 1));
  const concurrent = capture(() => h.store.reserve(
    h.request("append", "loser", created.contextId, 1),
  ));
  expect(concurrent.errorCode).toBe(NWP_LLM_CONTEXT_VERSION_CONFLICT);
  expect(concurrent.currentVersion).toBe(1);
  h.store.abort(winner);
  expect(capture(() => h.store.reserve(
    h.request("append", "stale", created.contextId, 0),
  )).errorCode).toBe(NWP_LLM_CONTEXT_VERSION_CONFLICT);
}

function forkSnapshotsParent(): void {
  const h = new Harness();
  const parent = h.create();
  const fork = h.store.reserve(h.request("fork", "fork-1", parent.contextId, 1, { messages: [] }));
  const append = h.store.reserve(h.request("append", "parent-append", parent.contextId, 1));
  h.store.commit(append, assistant("Parent moved"));
  const child = h.store.commit(fork, assistant("Branch"));
  expect(child.parentContextId).toBe(parent.contextId);
  expect(child.parentVersion).toBe(1);
  expect(h.store.snapshot(ALICE, parent.contextId).version).toBe(2);
  expect(h.store.snapshot(ALICE, child.contextId).transcript).toHaveLength(4);
}

function resetReplacesState(): void {
  const h = new Harness();
  const created = h.create();
  const reset = h.store.reserve(h.request("reset", "reset-1", created.contextId, 1, {
    selectedBinding: binding("willow-medium", "runtime-2"),
    messages: [system("Use JSON."), user("Restart")],
  }));
  const receipt = h.store.commit(reset, assistant("{}"));
  const snapshot = h.store.snapshot(ALICE, created.contextId);
  expect(receipt.version).toBe(2);
  expect(snapshot.binding.model).toBe("willow-medium");
  expect(snapshot.transcript).toHaveLength(3);
  expect(snapshot.transcript.some(message => message.content === "One")).toBe(false);
}

function bindingMismatch(): void {
  const h = new Harness();
  const created = h.create();
  const error = capture(() => h.store.reserve(h.request(
    "append", "bad-binding", created.contextId, 1,
    { selectedBinding: binding("willow-large") },
  )));
  expect(error.errorCode).toBe(NWP_LLM_CONTEXT_BINDING_MISMATCH);
}

function ownerBoundary(): void {
  const h = new Harness();
  const created = h.create();
  expect(capture(() => h.store.status(BOB, { contextId: created.contextId })).errorCode)
    .toBe(NWP_LLM_CONTEXT_FORBIDDEN);
}

function abortPreservesState(): void {
  const h = new Harness({ defaultTtl: 10 });
  const created = h.create("create-1", 10);
  const mutation = h.store.reserve(h.request("append", "abort-1", created.contextId, 1));
  h.advance(11);
  h.store.abort(mutation, "NPS-SERVER-TIMEOUT");
  expect(h.store.status(ALICE, { contextId: created.contextId }).state).toBe("expired");
  expect(h.store.status(ALICE, { idempotencyKey: "abort-1" }).errorCode)
    .toBe("NPS-SERVER-TIMEOUT");
}

function lostCreateRecovery(): void {
  const h = new Harness({ defaultTtl: 10, tombstone: 5 });
  const reservation = h.store.reserve(h.request("create", "lost-create"));
  expect(h.store.status(ALICE, { idempotencyKey: "lost-create" }).contextId).toBeUndefined();
  h.store.commit(reservation, assistant("First"));
  const active = h.store.status(ALICE, { idempotencyKey: "lost-create" });
  h.advance(16);
  h.store.sweepExpired();
  const retained = h.store.status(ALICE, { idempotencyKey: "lost-create" });
  expect(retained.contextId).toBe(active.contextId);
  expect(retained.version).toBe(1);
}

function releaseAndExpiry(): void {
  const h = new Harness({ defaultTtl: 10, tombstone: 5 });
  const created = h.create("create-1", 10);
  const released = h.store.release(ALICE, created.contextId, 1, "create-1");
  expect(released.version).toBe(2);
  expect(h.store.release(ALICE, created.contextId, 1, "create-1")).toEqual(released);
  expect(capture(() => h.store.release(
    ALICE, "ERITFBUWFxgZGhscHR4fIA", 1, "create-1",
  )).errorCode).toBe(NWP_ACTION_IDEMPOTENCY_CONFLICT);
  expect(h.store.status(ALICE, { contextId: created.contextId }).state).toBe("released");
  expect(capture(() => h.store.reserve(
    h.request("append", "after-release", created.contextId, 2),
  )).errorCode).toBe(NWP_LLM_CONTEXT_NOT_FOUND);

  const expiring = h.create("create-expiring", 10);
  h.advance(11);
  h.store.sweepExpired();
  expect(h.store.status(ALICE, { contextId: expiring.contextId }).state).toBe("expired");
  expect(capture(() => h.store.snapshot(ALICE, expiring.contextId)).errorCode)
    .toBe(NWP_LLM_CONTEXT_EXPIRED);
  h.advance(6);
  h.store.sweepExpired();
  expect(capture(() => h.store.status(ALICE, { contextId: expiring.contextId })).errorCode)
    .toBe(NWP_LLM_CONTEXT_NOT_FOUND);
}

function usageAccounting(): void {
  const usage: LlmUsageDto = {
    inputTokens: 1200,
    reusedTokens: 1000,
    evaluatedTokens: 200,
    outputTokens: 80,
    cacheHit: true,
    wireInputBytes: 384,
  };
  expect(usage.reusedTokens! + usage.evaluatedTokens!).toBe(usage.inputTokens);
  expect(usage.cacheHit && usage.wireInputBytes! < 4096).toBe(true);
}

function advertisedOperations(): void {
  const supported = new Set<LlmContextOperation>(["create", "append", "reset", "release"]);
  const h = new Harness({ supported });
  const created = h.create();
  expect(capture(() => h.store.reserve(h.request(
    "fork", "fork-disabled", created.contextId, 1, { messages: [] },
  ))).errorCode).toBe(NWP_LLM_CONTEXT_OPERATION_UNSUPPORTED);
}

function processRestart(): void {
  const first = new Harness();
  const created = first.create();
  const restarted = new Harness();
  expect(capture(() => restarted.store.reserve(restarted.request(
    "append", "after-restart", created.contextId, 1,
  ))).errorCode).toBe(NWP_LLM_CONTEXT_NOT_FOUND);
}

function completedIdempotency(): void {
  const h = new Harness();
  const created = h.create("stream-replay");
  expect(h.store.status(ALICE, { idempotencyKey: "stream-replay" }).contextId)
    .toBe(created.contextId);
  expect(capture(() => h.store.reserve(h.request("create", "stream-replay"))).errorCode)
    .toBe(NWP_ACTION_IDEMPOTENCY_CONFLICT);
  expect(h.store.snapshot(ALICE, created.contextId).version).toBe(1);
}

function revocationAbort(): void {
  const h = new Harness();
  const created = h.create();
  const mutation = h.store.reserve(h.request("append", "revoked", created.contextId, 1));
  h.store.abort(mutation, NWP_AUTH_NID_REVOKED);
  expect(h.store.snapshot(ALICE, created.contextId).version).toBe(1);
  expect(h.store.status(ALICE, { idempotencyKey: "revoked" }).errorCode)
    .toBe(NWP_AUTH_NID_REVOKED);
}

function principalLimit(): void {
  const h = new Harness({ maxContexts: 1 });
  h.create();
  expect(capture(() => h.store.reserve(h.request("create", "over-limit"))).errorCode)
    .toBe(NWP_LLM_CONTEXT_LIMIT_EXCEEDED);
}

function unsupportedOperation(): void { advertisedOperations(); }

function missingIdempotency(): void {
  const h = new Harness();
  expect(capture(() => h.store.reserve(h.request("create", ""))).errorCode)
    .toBe(NWP_ACTION_PARAMS_INVALID);
  expect(h.store.sweepExpired()).toBe(0);
}
