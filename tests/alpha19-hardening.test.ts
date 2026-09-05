// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateNcpRuntime, evaluateNdpRecovery, evaluateNipAdvisory, evaluateNipRenewal, evaluateNipRevocation, evaluateNopReplay, evaluateNwpSubscription, normalizeNwpMetadata } from "../src/alpha19.js";
import { conformanceFixture } from "./conformance-fixtures.js";

const vectors = (protocol: string, name: string): any[] => JSON.parse(readFileSync(conformanceFixture(protocol, name), "utf8")).vectors;

describe("alpha.19 shared hardening", () => {
  it("executes all five shared vector families", () => {
    const suites: Array<[string, string, (v: any) => any]> = [
      ["ncp", "runtime_hardening_vectors.json", (v) => evaluateNcpRuntime(v.input)],
      ["nwp", "alpha19_hardening_vectors.json", (v) => v.id.includes(".metadata.") ? normalizeNwpMetadata(v.input) : evaluateNwpSubscription(v.input)],
      ["nip", "renewal_revocation_vectors.json", (v) => v.id.includes(".renewal.") ? evaluateNipRenewal(v.input) : v.id.includes(".revocation.") ? evaluateNipRevocation(v.input) : evaluateNipAdvisory(v.input)],
      ["ndp", "recovery_fence_vectors.json", (v) => evaluateNdpRecovery(v.input)],
      ["nop", "replay_retention_vectors.json", (v) => evaluateNopReplay(v.input)],
    ];
    const seen = new Set<string>();
    for (const [protocol, name, evaluate] of suites) for (const vector of vectors(protocol, name)) {
      expect(seen.has(vector.id), vector.id).toBe(false); seen.add(vector.id);
      expect(evaluate(vector), vector.id).toEqual(vector.expected);
    }
    expect(seen.size).toBe(47);
  });
});
