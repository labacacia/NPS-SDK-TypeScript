// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Aggregates results from multiple completed subtasks using the strategy
// defined in SyncFrame.aggregate or the orchestrator default (NPS-5 §3.3.2).
// TypeScript port of NPS.NOP.Orchestration.NopResultAggregator.

import { AggregateStrategy } from "./models.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merges all object results into one (last-write-wins on key conflicts).
 * Non-object results are added under `_result_{i}` keys.
 */
export function merge(results: readonly unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (isPlainObject(result)) {
      for (const [k, v] of Object.entries(result)) merged[k] = v;
    } else {
      merged[`_result_${i}`] = result;
    }
  }
  return merged;
}

/** Returns all results as an array. */
export function buildArray(results: readonly unknown[]): unknown[] {
  return [...results];
}

/**
 * Aggregates `results` using `strategy`.
 * @param minRequired for `fastest_k`: how many results to include; ignored otherwise.
 */
export function aggregate(
  strategy: string,
  results: readonly unknown[],
  minRequired = 0,
): unknown {
  if (results.length === 0) return {};

  switch (strategy) {
    case AggregateStrategy.FIRST:
      return results[0];
    case AggregateStrategy.ALL:
      return buildArray(results);
    case AggregateStrategy.FASTEST_K:
      return buildArray(results.slice(0, minRequired > 0 ? minRequired : results.length));
    default:
      // "merge", "merge_all", "weighted_first_k", and any unknown → merge
      return merge(results);
  }
}

/**
 * Filters `allResults` to only end nodes (nodes with no outgoing edges),
 * then aggregates.
 */
export function aggregateEndNodes(
  endNodeIds: readonly string[],
  allResults: ReadonlyMap<string, unknown>,
  strategy: string = AggregateStrategy.MERGE,
): unknown {
  const endResults = endNodeIds
    .filter((id) => allResults.has(id))
    .map((id) => allResults.get(id));
  return aggregate(strategy, endResults);
}
