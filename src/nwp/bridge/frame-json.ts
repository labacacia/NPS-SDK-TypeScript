// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import type { NpsFrame } from "../../core/codec.js";

/**
 * Serializes NWP frames to the snake_case JSON shape used by inbound Bridge
 * server payloads (port of the internal .NET `BridgeFrameJson`).
 */
export const BridgeFrameJson = {
  toElement(frame: NpsFrame): Record<string, unknown> {
    return frame.toDict();
  },

  serialize(frame: NpsFrame): string {
    return JSON.stringify(frame.toDict());
  },
};
