// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Protocol-level limits defined by NPS-5 §8.2.
// TypeScript port of NPS.NOP.NopConstants.

export const NopConstants = {
  /** Maximum number of nodes in a single DAG. */
  MaxDagNodes: 32,

  /** Maximum delegation chain depth (Orchestrator → Worker → Sub-Worker). */
  MaxDelegateChainDepth: 3,

  /** Maximum length of a CEL condition expression in characters. */
  MaxConditionLength: 512,

  /** Maximum JSONPath nesting depth in input_mapping values. */
  MaxInputMappingDepth: 8,

  /** Default task timeout in milliseconds. */
  DefaultTimeoutMs: 30_000,

  /** Maximum task timeout in milliseconds (1 hour). */
  MaxTimeoutMs: 3_600_000,

  /** Default AnchorFrame TTL in seconds. */
  DefaultAnchorTtl: 3600,

  /**
   * Maximum number of callback POST attempts with exponential backoff (NPS-5 §8.4).
   * Attempts use delays: 0 s, 1 s, 2 s (first attempt is immediate).
   */
  CallbackMaxRetries: 3,
} as const;
