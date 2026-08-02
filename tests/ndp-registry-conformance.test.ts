// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NdpRegistryProfile,
  canonicalAnnounceJson,
  verifyAnnounceSignature,
} from "../src/ndp/registry-profile.js";
import { AnnounceFrame } from "../src/ndp/frames.js";
import { NdpAnnounceValidator } from "../src/ndp/validator.js";
import { conformanceFixture } from "./conformance-fixtures.js";

function vectors(relative: string): Array<Record<string, any>> {
  return JSON.parse(
    readFileSync(
      conformanceFixture(
        ...relative.replace(/^spec\/conformance\//, "").split("/"),
      ),
      "utf8",
    ),
  ).vectors;
}

describe("NDP 0.12 Registry Conformance", () => {
  it("passes every shared canonicalization vector", () => {
    const cases = vectors(
      "spec/conformance/ndp/announce_canonicalization_vectors.json",
    );
    expect(cases).toHaveLength(3);
    for (const vector of cases) {
      expect(canonicalAnnounceJson(vector.input.frame), vector.id).toBe(
        vector.expected.canonical_json,
      );
      expect(
        verifyAnnounceSignature(
          vector.input.frame,
          vector.input.public_key,
          vector.input.signature,
        ),
        vector.id,
      ).toBe(vector.expected.signature_valid);
      const frame = AnnounceFrame.fromDict({
        ...vector.input.frame,
        signature: vector.input.signature,
      });
      const validator = new NdpAnnounceValidator();
      validator.registerPublicKey(frame.nid, vector.input.public_key);
      expect(validator.validate(frame).isValid, vector.id).toBe(
        vector.expected.signature_valid,
      );
    }
  });

  it("passes every shared registry transcript", () => {
    const cases = vectors(
      "spec/conformance/ndp/registry_consistency_vectors.json",
    );
    expect(cases).toHaveLength(16);
    for (const vector of cases) {
      const input = vector.input;
      const expected = vector.expected;
      const now = new Date(input.now);
      const registry = new NdpRegistryProfile(input.profile);
      const outcomes = input.announces.map((announce: Record<string, any>) =>
        registry.applyAnnounce(
          announce.frame,
          announce.signature_valid,
          new Date(announce.received_at ?? input.now),
        ),
      );

      expect(
        outcomes.map((result) => result.decision),
        vector.id,
      ).toEqual(expected.decisions);
      expect(
        outcomes.map((result) => result.errorCode ?? null),
        vector.id,
      ).toEqual(expected.errors);
      expect(registry.liveNids(now), vector.id).toEqual(expected.live_nids);
      expect(registry.highestSequences(), vector.id).toEqual(
        expected.highest_sequences,
      );

      if (input.cluster_query) {
        const selected = registry.resolveCluster(input.cluster_query, now);
        expect(selected.nid, vector.id).toBe(expected.selected_nid);
        expect(selected.epoch, vector.id).toBe(expected.selected_epoch);
        expect(selected.errorCode, vector.id).toBe(expected.cluster_error);
      }

      if (input.bridge_queries) {
        expect(
          input.bridge_queries.map((query: Record<string, string>) =>
            registry.discoverBridges(query.direction, query.protocol, now),
          ),
          vector.id,
        ).toEqual(expected.bridge_results);
      }

      if (expected.resolve_error) {
        expect(registry.hasStaleEntry(now), vector.id).toBe(true);
      }
    }
  });
});
