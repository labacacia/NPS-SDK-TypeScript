// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { evaluateCondition } from "./condition-evaluator.js";
import {
  NOP_CALLBACK_HMAC_INVALID,
  NOP_CALLBACK_HMAC_MISSING,
  NOP_CALLBACK_INVALID,
  NOP_COMPENSATION_FAILED,
  NOP_COMPENSATION_NOT_SUPPORTED,
  NOP_CONDITION_EVAL_ERROR,
  NOP_DELEGATE_REJECTED,
  NOP_DELEGATE_SCOPE_VIOLATION,
  NOP_DELEGATE_TIMEOUT,
  NOP_INPUT_MAPPING_ERROR,
  NOP_RESOURCE_INSUFFICIENT,
  NOP_RUNTIME_IDLE_TIMEOUT,
  NOP_RUNTIME_MAX_RUNTIME,
  NOP_SPAWN_SPEC_INVALID,
  NOP_TASK_CANCELLED,
  NOP_TASK_DAG_CYCLE,
} from "./nop-error-codes.js";
import { resolvePath } from "./input-mapper.js";

type JsonObject = Record<string, unknown>;
type NodeInput = JsonObject & {
  id: string;
  depends_on: string[];
  attempts: JsonObject[];
};

const CLUSTER_SPLIT = "NDP-CLUSTER-SPLIT";

/** Run one shared deterministic NOP 0.9 orchestration transcript. */
export function evaluateOrchestration(task: JsonObject): JsonObject {
  const nodes = new Map<string, NodeInput>();
  for (const raw of task["nodes"] as NodeInput[]) {
    if (nodes.has(raw.id)) return emptyFailure("NOP-TASK-DAG-INVALID");
    nodes.set(raw.id, raw);
  }
  const topo = stableTopology(nodes);
  if (topo === undefined) return emptyFailure(NOP_TASK_DAG_CYCLE);

  const events: string[] = [];
  if (task["preflight"] === true) {
    events.push("task:preflight");
    if (topo.some((id) => nodes.get(id)?.["preflight_available"] === false)) {
      events.push("task:failed");
      return result(events, "failed", NOP_RESOURCE_INSUFFICIENT);
    }
  }
  events.push("task:running");
  const results = new Map<string, unknown>();
  const states = new Map<string, string>();
  const attempts = new Map<string, number>();
  const mapped = new Map<string, unknown>();
  const taskRetries = numberValue(task["max_retries"], 0);

  for (const id of topo) {
    const node = nodes.get(id)!;
    if (task["cancel_before"] === id) {
      events.push("task:cancelled");
      return result(
        events,
        "cancelled",
        NOP_TASK_CANCELLED,
        null,
        states,
        attempts,
        mapped,
      );
    }

    if (typeof node["condition"] === "string") {
      let condition: boolean;
      try {
        condition = evaluateCondition(node["condition"], results);
      } catch {
        states.set(id, "failed");
        attempts.set(id, 0);
        events.push(`${id}:failed`, "task:failed");
        return result(
          events,
          "failed",
          NOP_CONDITION_EVAL_ERROR,
          null,
          states,
          attempts,
          mapped,
        );
      }
      if (!condition) {
        states.set(id, "skipped");
        attempts.set(id, 0);
        events.push(`${id}:skipped`);
        continue;
      }
    }

    const mapping = node["input_mapping"] as JsonObject | undefined;
    if (mapping !== undefined) {
      const params: JsonObject = {};
      try {
        for (const [name, path] of Object.entries(mapping)) {
          const value = resolvePath(String(path), results);
          if (value === undefined) throw new Error("missing mapping path");
          params[name] = clone(value);
        }
      } catch {
        states.set(id, "failed");
        attempts.set(id, 0);
        events.push(`${id}:failed`, "task:failed");
        return result(
          events,
          "failed",
          NOP_INPUT_MAPPING_ERROR,
          null,
          states,
          attempts,
          mapped,
        );
      }
      mapped.set(id, params);
    }

    const maxRetries = numberValue(node["max_retries"], taskRetries);
    let finalError: string | undefined;
    let completed = false;
    let count = 0;
    for (
      let index = 0;
      index < node.attempts.length && index <= maxRetries;
      index++
    ) {
      const outcome = node.attempts[index];
      count++;
      events.push(`${id}:attempt:${count}`);
      if (outcome["kind"] === "success") {
        results.set(id, clone(outcome["result"] ?? {}));
        states.set(id, "completed");
        events.push(`${id}:completed`);
        completed = true;
        break;
      }
      finalError =
        outcome["kind"] === "timeout"
          ? NOP_DELEGATE_TIMEOUT
          : String(outcome["error_code"] ?? NOP_DELEGATE_REJECTED);
      const retryable =
        outcome["kind"] === "timeout" || outcome["retryable"] === true;
      const retryOn = node["retry_on"] as string[] | undefined;
      const selected = retryOn === undefined || retryOn.includes(finalError);
      if (
        retryable &&
        selected &&
        count <= maxRetries &&
        index + 1 < node.attempts.length
      ) {
        events.push(`${id}:retrying`);
        continue;
      }
      states.set(id, "failed");
      events.push(`${id}:failed`);
      break;
    }
    attempts.set(id, count);
    if (completed) continue;

    const compensation = compensate(task, id, topo, nodes, states, events);
    events.push("task:failed");
    return result(
      events,
      "failed",
      compensation.error ?? finalError ?? NOP_DELEGATE_REJECTED,
      null,
      states,
      attempts,
      mapped,
      compensation.order,
    );
  }

  const aggregate = aggregateResults(task, topo, nodes, states, results);
  events.push("task:completed");
  return result(events, "completed", null, aggregate, states, attempts, mapped);
}

/** Evaluate one shared runtime/security vector category. */
export function evaluateRuntime(
  category: string,
  input: JsonObject,
): JsonObject {
  switch (category) {
    case "callback":
      return evaluateCallback(input);
    case "hmac":
      return evaluateHmac(input);
    case "lease":
      return evaluateLease(input);
    case "delegation":
      return evaluateDelegation(input);
    case "spawn_spec":
      return evaluateSpawnSpec(input);
    case "lifecycle":
      return evaluateLifecycle(input);
    case "dedup_key":
      return {
        value: computeDedupKey(
          String(input["task_id"]),
          String(input["dag_hash"]),
        ),
      };
    default:
      throw new RangeError(`Unknown NOP profile category: ${category}`);
  }
}

/** SHA-256(task_id + NUL + dag_hash), lowercase hex. */
export function computeDedupKey(taskId: string, dagHash: string): string {
  return createHash("sha256")
    .update(taskId)
    .update("\0")
    .update(dagHash)
    .digest("hex");
}

function stableTopology(nodes: Map<string, NodeInput>): string[] | undefined {
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  const outgoing = new Map([...nodes.keys()].map((id) => [id, [] as string[]]));
  for (const [id, node] of nodes) {
    for (const dependency of node.depends_on) {
      if (!nodes.has(dependency)) return undefined;
      indegree.set(id, indegree.get(id)! + 1);
      outgoing.get(dependency)!.push(id);
    }
  }
  const ready = [...indegree]
    .filter(([, value]) => value === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of [...outgoing.get(id)!].sort()) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  return order.length === nodes.size ? order : undefined;
}

function compensate(
  task: JsonObject,
  failedId: string,
  topo: string[],
  nodes: Map<string, NodeInput>,
  states: Map<string, string>,
  events: string[],
): { order: string[]; error?: string } {
  const policy = task["compensation_policy"];
  if (policy !== "best_effort" && policy !== "strict") return { order: [] };
  const ancestors = new Set<string>();
  const collect = (id: string): void => {
    for (const dependency of nodes.get(id)!.depends_on) {
      if (!ancestors.has(dependency)) {
        ancestors.add(dependency);
        collect(dependency);
      }
    }
  };
  collect(failedId);
  const candidates = topo
    .filter((id) => ancestors.has(id) && states.get(id) === "completed")
    .reverse();
  if (
    policy === "strict" &&
    candidates.some((id) => nodes.get(id)?.["compensate_action"] === undefined)
  ) {
    return { order: [], error: NOP_COMPENSATION_NOT_SUPPORTED };
  }
  const order: string[] = [];
  for (const id of candidates) {
    const node = nodes.get(id)!;
    if (node["compensate_action"] === undefined) continue;
    order.push(id);
    events.push(`${id}:compensating`);
    if (node["compensation_outcome"] === "failure") {
      states.set(id, "compensation_failed");
      events.push(`${id}:compensation_failed`);
      if (policy === "strict") return { order, error: NOP_COMPENSATION_FAILED };
    } else {
      states.set(id, "compensated");
      events.push(`${id}:compensated`);
    }
  }
  return { order };
}

function aggregateResults(
  task: JsonObject,
  topo: string[],
  nodes: Map<string, NodeInput>,
  states: Map<string, string>,
  results: Map<string, unknown>,
): unknown {
  const hasOutgoing = new Set(
    [...nodes.values()].flatMap((node) => node.depends_on),
  );
  const values = topo
    .filter(
      (id) =>
        !hasOutgoing.has(id) &&
        states.get(id) === "completed" &&
        results.has(id),
    )
    .map((id) => clone(results.get(id)));
  if (values.length === 0) return null;
  if (task["aggregate"] === "all") return values;
  const output: JsonObject = {};
  for (const value of values) {
    if (!isObject(value)) continue;
    for (const [key, item] of Object.entries(value)) {
      if (
        task["aggregate"] === "merge_all" &&
        Array.isArray(output[key]) &&
        Array.isArray(item)
      ) {
        (output[key] as unknown[]).push(...clone(item));
      } else {
        output[key] = clone(item);
      }
    }
  }
  return output;
}

function evaluateCallback(input: JsonObject): JsonObject {
  let allowed = callbackDestinationAllowed(
    String(input["url"]),
    input["resolved_ips"] as string[],
  );
  if (allowed && input["redirect_url"] !== undefined) {
    allowed = callbackDestinationAllowed(
      String(input["redirect_url"]),
      input["redirect_resolved_ips"] as string[],
    );
  }
  return { allowed, error: allowed ? null : NOP_CALLBACK_INVALID };
}

function callbackDestinationAllowed(
  value: string,
  addresses: string[],
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hostname.length > 0 &&
    addresses.length > 0 &&
    addresses.every(isPublicAddress)
  );
}

function isPublicAddress(value: string): boolean {
  const v4 = value.split(".").map(Number);
  if (
    v4.length === 4 &&
    v4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return !(
      v4[0] === 0 ||
      v4[0] === 10 ||
      v4[0] === 127 ||
      (v4[0] === 169 && v4[1] === 254) ||
      (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) ||
      (v4[0] === 192 && v4[1] === 168) ||
      v4[0] >= 224
    );
  }
  const lower = value.toLowerCase();
  if (!lower.includes(":")) return false;
  return !(
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("ff")
  );
}

function evaluateHmac(input: JsonObject): JsonObject {
  if (input["signature"] == null) {
    return { valid: false, error: NOP_CALLBACK_HMAC_MISSING };
  }
  let valid = false;
  try {
    const key = Buffer.from(String(input["secret_base64url"]), "base64url");
    const supplied = String(input["signature"]);
    const expected =
      "sha256=" +
      createHmac("sha256", key).update(String(input["raw_body"])).digest("hex");
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    valid =
      key.length === 32 &&
      expectedBytes.length === suppliedBytes.length &&
      timingSafeEqual(expectedBytes, suppliedBytes);
  } catch {
    valid = false;
  }
  return { valid, error: valid ? null : NOP_CALLBACK_HMAC_INVALID };
}

interface Lease {
  runnerNid: string;
  expiresAt: number;
}

function evaluateLease(input: JsonObject): JsonObject {
  const leases = new Map<string, Lease>();
  const terminal = new Set<string>();
  const outcomes: string[] = [];
  for (const event of input["events"] as JsonObject[]) {
    const at = Number(event["at"]);
    const op = event["op"];
    if (op === "claim") {
      const taskId = String(event["task_id"]);
      const runner = String(event["runner_nid"]);
      const seconds = Math.min(
        600,
        Math.max(10, Number(event["lease_seconds"])),
      );
      const lease = leases.get(taskId);
      if (lease !== undefined && lease.expiresAt > at) {
        if (lease.runnerNid === runner) {
          leases.set(taskId, { runnerNid: runner, expiresAt: at + seconds });
          outcomes.push("granted");
        } else {
          outcomes.push("conflict");
        }
      } else {
        leases.set(taskId, { runnerNid: runner, expiresAt: at + seconds });
        outcomes.push(lease === undefined ? "granted" : "reclaimed");
      }
    } else if (op === "renew") {
      const taskId = String(event["task_id"]);
      const runner = String(event["runner_nid"]);
      const seconds = Math.min(
        600,
        Math.max(10, Number(event["lease_seconds"])),
      );
      const lease = leases.get(taskId);
      if (
        lease !== undefined &&
        lease.expiresAt > at &&
        lease.runnerNid === runner
      ) {
        leases.set(taskId, { runnerNid: runner, expiresAt: at + seconds });
        outcomes.push("granted");
      } else {
        outcomes.push("conflict");
      }
    } else if (op === "mark_terminal") {
      terminal.add(terminalKey(event));
      outcomes.push("recorded");
    } else if (op === "is_terminal") {
      outcomes.push(terminal.has(terminalKey(event)) ? "terminal" : "pending");
    }
  }
  return { outcomes };
}

function terminalKey(event: JsonObject): string {
  return `${String(event["dedup_key"])}\0${String(event["node_id"])}`;
}

function evaluateDelegation(input: JsonObject): JsonObject {
  const parent = input["parent_scope"] as JsonObject;
  const delegated = input["delegated_scope"] as JsonObject;
  if (
    !subset(delegated["nodes"] as string[], parent["nodes"] as string[]) ||
    !subset(delegated["actions"] as string[], parent["actions"] as string[]) ||
    Number(delegated["max_token_budget"]) > Number(parent["max_token_budget"])
  ) {
    return { targets: [], error: NOP_DELEGATE_SCOPE_VIOLATION };
  }
  const targets: string[] = [];
  for (const attempt of input["attempts"] as JsonObject[]) {
    const live = (attempt["candidates"] as JsonObject[]).filter(
      (candidate) => candidate["live"] === true,
    );
    if (live.length === 0) return { targets, error: NOP_DELEGATE_REJECTED };
    const highest = Math.max(
      ...live.map((candidate) => Number(candidate["cluster_epoch"])),
    );
    const leaders = live.filter(
      (candidate) => Number(candidate["cluster_epoch"]) === highest,
    );
    if (leaders.length !== 1) return { targets, error: CLUSTER_SPLIT };
    targets.push(String(leaders[0]["nid"]));
  }
  return { targets, error: null };
}

function evaluateSpawnSpec(input: JsonObject): JsonObject {
  const spec = input["spawn_spec"] as JsonObject;
  let valid =
    typeof spec["image"] === "string" && spec["image"].trim().length > 0;
  if (
    valid &&
    spec["idle_timeout_seconds"] !== undefined &&
    spec["max_runtime_seconds"] !== undefined &&
    Number(spec["idle_timeout_seconds"]) > Number(spec["max_runtime_seconds"])
  ) {
    valid = false;
  }
  return { error: valid ? null : NOP_SPAWN_SPEC_INVALID };
}

function evaluateLifecycle(input: JsonObject): JsonObject {
  if (
    Number(input["elapsed_seconds"]) >= Number(input["max_runtime_seconds"])
  ) {
    return { state: "failed", error: NOP_RUNTIME_MAX_RUNTIME };
  }
  if (Number(input["idle_seconds"]) >= Number(input["idle_timeout_seconds"])) {
    return { state: "failed", error: NOP_RUNTIME_IDLE_TIMEOUT };
  }
  if (input["worker_terminal"] === "done")
    return { state: "completed", error: null };
  return { state: "failed", error: NOP_DELEGATE_REJECTED };
}

function result(
  events: string[],
  terminalState: string,
  errorCode: string | null,
  aggregate: unknown = null,
  states: Map<string, string> = new Map(),
  attempts: Map<string, number> = new Map(),
  mapped: Map<string, unknown> = new Map(),
  compensation: string[] = [],
): JsonObject {
  return {
    events: [...events],
    terminal_state: terminalState,
    error_code: errorCode,
    aggregate: clone(aggregate),
    node_states: sortedObject(states),
    attempt_counts: sortedObject(attempts),
    mapped_params: sortedObject(mapped),
    compensation_order: [...compensation],
  };
}

function emptyFailure(error: string): JsonObject {
  return result(["task:failed"], "failed", error);
}

function sortedObject<T>(values: Map<string, T>): Record<string, T> {
  return Object.fromEntries(
    [...values].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function subset(values: string[], allowed: string[]): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
