// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateOrchestration,
  evaluateRuntime,
} from "../src/nop/portable-profile.js";
import { conformanceFixture } from "./conformance-fixtures.js";

function fixture(name: string): { vectors: Array<Record<string, unknown>> } {
  const path = conformanceFixture("nop", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("NOP 0.9 portable conformance profile", () => {
  it("passes shared orchestrator transcripts", () => {
    const vectors = fixture("orchestrator_transcripts.json").vectors;
    expect(vectors).toHaveLength(10);
    for (const vector of vectors) {
      expect(
        evaluateOrchestration(vector["input"] as Record<string, unknown>),
        String(vector["id"]),
      ).toEqual(vector["expected"]);
    }
  });

  it("passes shared runtime/security vectors", () => {
    const vectors = fixture("runtime_security_vectors.json").vectors;
    expect(vectors).toHaveLength(22);
    for (const vector of vectors) {
      expect(
        evaluateRuntime(
          String(vector["category"]),
          vector["input"] as Record<string, unknown>,
        ),
        String(vector["id"]),
      ).toEqual(vector["expected"]);
    }
  });
});
