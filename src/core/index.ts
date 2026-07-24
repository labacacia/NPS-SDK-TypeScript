// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// @labacacia/nps-sdk/core — public re-exports for NCP wire primitives.
//
// This module exposes the shipped OOP codec API used by NWP / NOP / NIP / NDP
// clients. The parallel functional API under ./codecs/ and ./frame-header.js
// remains importable by direct path but is not re-exported here to avoid
// symbol collisions (both files define FrameType / EncodingTier / FrameHeader).

// ── Frame primitives (OOP) ────────────────────────────────────────────────────
export {
  FrameType,
  EncodingTier,
  FrameFlags,
  FrameHeader,
  DEFAULT_HEADER_SIZE,
  EXTENDED_HEADER_SIZE,
  DEFAULT_MAX_PAYLOAD,
  EXTENDED_MAX_PAYLOAD,
} from "./frames.js";

// ── Codec (OOP) ───────────────────────────────────────────────────────────────
export {
  Tier1JsonCodec,
  Tier2MsgPackCodec,
  Tier3BinaryVectorCodec,
  NpsFrameCodec,
} from "./codec.js";
export type { NpsFrame } from "./codec.js";

// ── Registry (OOP) ────────────────────────────────────────────────────────────
export { FrameRegistry } from "./registry.js";
export type { FrameClass } from "./registry.js";

// ── Anchor cache (OOP) ────────────────────────────────────────────────────────
export { AnchorFrameCache } from "./cache.js";

// ── Exceptions / Status / Canonical JSON ──────────────────────────────────────
export * from "./exceptions.js";
export * from "./status-codes.js";
export { jcsStringify, sortKeysStringify } from "./canonical-json.js";
export type { CryptoProvider } from "./crypto-provider.js";

// ── NCP patch-format constants (NPS-1 §4.2) ────────────────────────────────────
// Mirrors NPS-sdk-dotnet/src/NPS.Core/NcpPatchFormat.cs, which lives in the core
// namespace. The canonical definitions live under ncp/ in this SDK.
export { PATCH_FORMAT, isValidPatchFormat } from "../ncp/ncp-patch-format.js";
export type { PatchFormat } from "../ncp/ncp-patch-format.js";

// ── Telemetry (metrics + tracing abstraction) ────────────────────────────────
// [I] infrastructure band. Dependency-free port of the .NET Meter /
// ActivitySource instrumentation model. See ../nwp/telemetry, ../nop/telemetry.
export * from "./telemetry.js";
