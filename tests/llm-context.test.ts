// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  LLM_COMPLETE,
  LLM_CONTEXT_RELEASE,
  LLM_CONTEXT_STATUS,
  llmCompleteActionFrame,
  llmCompleteRequestFromWire,
  llmCompleteRequestToWire,
  llmContextReleaseActionFrame,
  llmContextStatusActionFrame,
} from "../src/nwp/llm.js";
import { NpsStatusCodes, toHttpStatus } from "../src/core/status-codes.js";
import { NWP_ERROR_TO_NPS_STATUS, NWP_LLM_CONTEXT_LIMIT_EXCEEDED } from "../src/nwp/nwp-error-codes.js";

describe("NWP LLM context contract", () => {
  it("round-trips canonical stateful completion fields", () => {
    const request = {
      model: "willow-small",
      messages: [{ role: "user", content: "Hello" }],
      context: { operation: "create" as const, ttlSeconds: 600 },
    };
    const wire = llmCompleteRequestToWire(request);
    expect(wire).toEqual({
      kind: LLM_COMPLETE,
      model: "willow-small",
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
      context: { operation: "create", ttl_seconds: 600 },
    });
    expect(llmCompleteRequestFromWire(wire)).toEqual({
      kind: LLM_COMPLETE,
      model: "willow-small",
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
      context: { operation: "create", ttlSeconds: 600 },
    });
    expect(llmCompleteActionFrame(request, { idempotencyKey: "create-1" }).idempotencyKey)
      .toBe("create-1");
  });

  it("builds canonical lifecycle ActionFrames", () => {
    const status = llmContextStatusActionFrame({ idempotencyKey: "create-1" });
    expect(status.actionId).toBe(LLM_CONTEXT_STATUS);
    expect(status.params).toEqual({ idempotency_key: "create-1" });

    const release = llmContextReleaseActionFrame(
      { contextId: "AQIDBAUGBwgJCgsMDQ4PEA", baseVersion: 7 },
      { idempotencyKey: "release-1" },
    );
    expect(release.actionId).toBe(LLM_CONTEXT_RELEASE);
    expect(release.idempotencyKey).toBe("release-1");
    expect(release.params?.["base_version"]).toBe(7);
  });

  it("maps context resource limits to HTTP 429", () => {
    expect(NWP_ERROR_TO_NPS_STATUS[NWP_LLM_CONTEXT_LIMIT_EXCEEDED]).toBe(NpsStatusCodes.NPS_LIMIT_RESOURCE);
    expect(toHttpStatus(NpsStatusCodes.NPS_LIMIT_RESOURCE)).toBe(429);
  });
});
