// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createConformanceManifest,
  NODE_L1,
  NODE_L1_CASES,
  NODE_L2_CASES,
  validateConformanceManifest,
} from "../src/conformance.js";

describe("conformance", () => {
  it("contains expected L1 and L2 catalogs", () => {
    expect(NODE_L1_CASES).toHaveLength(20);
    // 16 pre-alpha.17 + 6 TC-N2-BridgeIn (NPS-CR-0010) + 9 TC-N2-HA (NPS-CR-0009)
    expect(NODE_L2_CASES).toHaveLength(31);
    expect(NODE_L1_CASES[0].id).toBe("TC-N1-NCP-01");
  });

  it("registers the two alpha.17 L2 case families in full", () => {
    const ids = NODE_L2_CASES.map((c) => c.id);
    // Certification is per family, all-or-nothing — a partially registered family is a bug.
    for (let i = 1; i <= 6; i++) expect(ids).toContain(`TC-N2-BridgeIn-0${i}`);
    for (let i = 1; i <= 9; i++) expect(ids).toContain(`TC-N2-HA-0${i}`);
  });

  it("accepts a complete L1 manifest", () => {
    const manifest = createConformanceManifest({
      profile: NODE_L1,
      iutName: "node",
      iutVersion: "0.1.0",
      iutNid: "urn:nps:node:example.test:node-1",
      peerName: "reference",
      peerVersion: "1.0.0-alpha.18",
      results: NODE_L1_CASES.map((c) => ({ id: c.id, result: c.optional ? "na" : "pass" })),
    });

    expect(validateConformanceManifest(manifest).valid).toBe(true);
  });

  it("rejects missing cases", () => {
    const manifest = createConformanceManifest({
      profile: NODE_L1,
      iutName: "node",
      iutVersion: "0.1.0",
      iutNid: "urn:nps:node:example.test:node-1",
      peerName: "reference",
      peerVersion: "1.0.0-alpha.18",
      results: NODE_L1_CASES.slice(0, -1).map((c) => ({ id: c.id, result: "pass" })),
    });

    const validation = validateConformanceManifest(manifest);

    expect(validation.valid).toBe(false);
    expect(validation.message).toContain("Missing conformance case results");
  });
});
