// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  evaluateBridgeLifecycle,
  evaluatePortableNode,
  type BridgeLifecycleRequest,
  type NwpPortableNodeRequest,
} from "../src/nwp/portable-profile.js";
import { conformanceFixture } from "./conformance-fixtures.js";

function vectors(name: string): Array<Record<string, any>> {
  return JSON.parse(readFileSync(conformanceFixture("nwp", name), "utf8"))
    .vectors;
}

function expectWire(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  id: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (key === "response") continue;
    const property = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    expect(actual[property], `${id} ${key}`).toEqual(value);
  }
}

describe("NWP v0.20 portable server profiles", () => {
  it("passes every portable Node server vector", () => {
    for (const vector of vectors("portable_node_server_vectors.json")) {
      const input = vector.input;
      const request: NwpPortableNodeRequest = {
        transport: input.transport,
        nodeRole: input.node_role,
        method: input.method,
        path: input.path,
        contentType: input.content_type,
        accept: input.accept,
        bodyBytes: input.body_bytes,
        maxBodyBytes: input.max_body_bytes,
        frameKind: input.frame_kind,
        bodyValid: input.body_valid,
        cancelled: input.cancelled,
        correlationId: input.correlation_id,
      };
      expectWire(
        evaluatePortableNode(request) as unknown as Record<string, unknown>,
        vector.expected,
        vector.id,
      );
    }
  });

  it("passes every Bridge lifecycle vector", () => {
    for (const vector of vectors("bridge_lifecycle_vectors.json")) {
      const input = vector.input;
      const request: BridgeLifecycleRequest = {
        protocol: input.protocol,
        endpoint: input.endpoint,
        registeredProtocols: input.registered_protocols,
        allowHttp: input.allow_http,
        rejectPrivate: input.reject_private,
        allowedPrefixes: input.allowed_prefixes,
        timeoutMs: input.timeout_ms,
        elapsedMs: input.elapsed_ms,
        cancelled: input.cancelled,
        correlationId: input.correlation_id,
        taskMode: input.task_mode,
      };
      expectWire(
        evaluateBridgeLifecycle(request) as unknown as Record<string, unknown>,
        vector.expected,
        vector.id,
      );
    }
  });
});
