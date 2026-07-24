// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Resolves NOP JSONPath expressions of the form `$.node_id.field.subfield`
// against a map of upstream node results (NPS-5 §3.1.3).
// TypeScript port of NPS.NOP.Orchestration.NopInputMapper.
//
// Path syntax:
//   $                    — the entire upstream context (all node results combined)
//   $.node_id            — the full result object of a specific node
//   $.node_id.field      — a specific field within a node's result
//   $.node_id.field.sub  — nested navigation (max NopConstants.MaxInputMappingDepth levels)

import { NopConstants } from "./constants.js";
import { NOP_INPUT_MAPPING_ERROR } from "./nop-error-codes.js";

/** Thrown when an input mapping path cannot be resolved. */
export class NopMappingError extends Error {
  readonly errorCode: string;
  constructor(message: string, errorCode: string) {
    super(message);
    this.name = "NopMappingError";
    this.errorCode = errorCode;
  }
}

/**
 * Resolves a single JSONPath expression against the upstream node-result context.
 * Returns `undefined` when the path leads to a missing property.
 * @throws {NopMappingError} for malformed paths or depth violations.
 */
export function resolvePath(
  path: string,
  context: ReadonlyMap<string, unknown>,
): unknown {
  if (path == null || path.trim().length === 0)
    throw new NopMappingError("Input mapping path must not be empty.", NOP_INPUT_MAPPING_ERROR);

  if (!path.startsWith("$."))
    throw new NopMappingError(
      `Input mapping path must start with '$.' — got: ${path}`,
      NOP_INPUT_MAPPING_ERROR,
    );

  // Split: "$", "node_id", "field", "sub", ... (drop empty segments).
  const parts = path.split(".").filter((p) => p.length > 0);
  // parts[0] === "$"

  if (parts.length > NopConstants.MaxInputMappingDepth + 1)
    throw new NopMappingError(
      `Input mapping path depth ${parts.length - 1} exceeds maximum ` +
        `${NopConstants.MaxInputMappingDepth}: ${path}`,
      NOP_INPUT_MAPPING_ERROR,
    );

  if (parts.length === 1) {
    // Just "$" → the entire context as a plain object.
    const all: Record<string, unknown> = {};
    for (const [k, v] of context) all[k] = v;
    return all;
  }

  const nodeId = parts[1];
  if (!context.has(nodeId)) return undefined;

  let current = context.get(nodeId);
  if (parts.length === 2) return current; // "$.node_id" → full result

  for (let i = 2; i < parts.length; i++) {
    if (current == null || typeof current !== "object" || Array.isArray(current))
      return undefined;
    const obj = current as Record<string, unknown>;
    if (!(parts[i] in obj)) return undefined;
    current = obj[parts[i]];
  }
  return current;
}

/**
 * Builds a `DelegateFrame.params` object by resolving all `input_mapping`
 * entries against the upstream result context.
 * @param inputMapping node's input_mapping (parameter → JSONPath string or array of paths).
 * @param context      upstream node results.
 */
export function buildParams(
  inputMapping: Readonly<Record<string, unknown>> | undefined | null,
  context: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  if (inputMapping == null || Object.keys(inputMapping).length === 0) return {};

  const out: Record<string, unknown> = {};
  for (const [paramName, pathValue] of Object.entries(inputMapping)) {
    if (typeof pathValue === "string") {
      out[paramName] = resolvePath(pathValue, context);
    } else if (Array.isArray(pathValue)) {
      out[paramName] = pathValue.map((p) =>
        typeof p === "string" ? resolvePath(p, context) : p,
      );
    } else {
      out[paramName] = pathValue;
    }
  }
  return out;
}
