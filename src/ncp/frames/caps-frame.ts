// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 LabAcacia / INNO LOTUS PTY LTD
//
// CapsFrame (0x04) — Capsule response envelope
// NPS-1 §4.4

import { NcpError } from "../../core/frame-header.js";
import {
  computeAnchorId,
  type AnchorFrame,
  type FrameSchema,
} from "./anchor-frame.js";

export interface CapsFrameInlineAnchor {
  anchor_id: string;
  schema: FrameSchema;
  ttl?: number;
}

export interface CapsFrame {
  frame: string;
  anchor_ref: string;
  count: number;
  data: unknown[];
  next_cursor?: string | null;
  token_est?: number;
  tokenizer_used?: string;
  cached?: boolean;
  request_id?: string;
  inline_anchor?: CapsFrameInlineAnchor;
}

/**
 * Validate a CapsFrame.
 *
 * Checks:
 * - count matches data.length (NPS-CLIENT-BAD-FRAME)
 * - if inline_anchor present, recomputes anchor_id and validates match (NCP-ANCHOR-SCHEMA-INVALID)
 *
 * @throws {NcpError} NPS-CLIENT-BAD-FRAME if count doesn't match data length.
 * @throws {NcpError} NCP-ANCHOR-SCHEMA-INVALID if inline_anchor.anchor_id doesn't match schema.
 */
export function validateCapsFrame(frame: CapsFrame): void {
  if (frame.count !== frame.data.length) {
    throw new NcpError(
      "NPS-CLIENT-BAD-FRAME",
      `CapsFrame count mismatch: count=${frame.count}, data.length=${frame.data.length}`,
    );
  }

  if (frame.inline_anchor !== undefined) {
    const computed = computeAnchorId(frame.inline_anchor.schema);
    if (frame.inline_anchor.anchor_id !== computed) {
      throw new NcpError(
        "NCP-ANCHOR-SCHEMA-INVALID",
        `inline_anchor anchor_id mismatch: expected ${computed}, got ${frame.inline_anchor.anchor_id}`,
      );
    }
  }
}
