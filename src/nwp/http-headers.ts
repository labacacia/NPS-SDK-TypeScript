// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NWP HTTP header and MIME constants (port of .NET `NwpHttpHeaders`).
 * Header names are matched case-insensitively on the wire.
 */

// Request headers
export const HDR_AGENT = "X-NWP-Agent";
export const HDR_BUDGET = "X-NWP-Budget";
export const HDR_IDENT = "X-NWP-Ident";
export const HDR_CAPABILITIES = "X-NWP-Capabilities";
export const HDR_DEPTH = "X-NWP-Depth";
export const HDR_ENCODING = "X-NWP-Encoding";
export const HDR_TOKENIZER = "X-NWP-Tokenizer";
/** NPS-CR-0009 — `cluster_epoch` an inbound request claims, for the Anchor epoch fence. */
export const HDR_CLUSTER_EPOCH = "X-NWP-Cluster-Epoch";
/** NPS-CR-0009 — NID of the sending Anchor, used as `successor_nid` when the fence fires. */
export const HDR_ANCHOR_NID = "X-NWP-Anchor-Nid";

// Response headers
export const HDR_SCHEMA = "X-NWP-Schema";
export const HDR_TOKENS = "X-NWP-Tokens";
export const HDR_TOKENS_NATIVE = "X-NWP-Tokens-Native";
export const HDR_TOKENIZER_USED = "X-NWP-Tokenizer-Used";
export const HDR_CACHED = "X-NWP-Cached";
export const HDR_NODE_TYPE = "X-NWP-Node-Type";
export const HDR_REQUEST_ID = "X-NWP-Request-Id";
export const HDR_REPUTATION_STATUS = "X-NWP-Reputation-Status";
export const HDR_BAN_EXPIRES = "X-NWP-Ban-Expires";

// MIME types
export const MIME_FRAME = "application/nwp-frame";
export const MIME_LEGACY_FRAME = "application/x-nps-frame";
export const MIME_CAPSULE = "application/nwp-capsule";
export const MIME_ERROR = "application/nwp-error+json";
export const MIME_MANIFEST = "application/nwp-manifest+json";
