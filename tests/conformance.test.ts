// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createConformanceManifest,
  NODE_L1,
  NODE_L1_CASES,
  NODE_L2,
  NODE_L2_CASES,
  validateConformanceManifest,
} from "../src/conformance.js";

describe("conformance", () => {
  it("contains expected L1 and L2 catalogs", () => {
    expect(NODE_L1_CASES).toHaveLength(20);
    // 7 AaaS baseline + 31 topology/transport/Bridge/HA cases.
    expect(NODE_L2_CASES).toHaveLength(38);
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
      results: NODE_L1_CASES.map((c) => ({
        id: c.id,
        result: c.optional ? "na" : "pass",
      })),
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
      results: NODE_L1_CASES.slice(0, -1).map((c) => ({
        id: c.id,
        result: "pass",
      })),
    });

    const validation = validateConformanceManifest(manifest);

    expect(validation.valid).toBe(false);
    expect(validation.message).toContain("Missing conformance case results");
  });

  it("accepts whole-family na and rejects partial-family na for L2", () => {
    const results = NODE_L2_CASES.map((c) => ({
      id: c.id,
      result:
        c.id.startsWith("TC-N2-AaaS-") ||
        c.id.startsWith("TC-N2-Anchor") ||
        c.id === "TC-N2-HA-09"
          ? "pass"
          : "na",
    }));
    const manifest = createConformanceManifest({
      profile: NODE_L2,
      iutName: "single-anchor",
      iutVersion: "0.1.0",
      iutNid: "urn:nps:node:example.test:anchor-1",
      peerName: "reference",
      peerVersion: "1.0.0-alpha.18",
      results,
    });

    expect(manifest.profile_version).toBe("0.7");
    expect(validateConformanceManifest(manifest).valid).toBe(true);

    manifest.cases.find((c) => c.id === "TC-N2-Tls-01")!.result = "pass";
    manifest.summary.pass += 1;
    manifest.summary.na -= 1;
    const validation = validateConformanceManifest(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.message).toContain("must be all pass or all na");

    manifest.cases.find((c) => c.id === "TC-N2-Tls-01")!.result = "na";
    manifest.cases.find((c) => c.id === "TC-N2-HA-09")!.result = "na";
    manifest.summary.pass -= 2;
    manifest.summary.na += 2;
    const applicability = validateConformanceManifest(manifest);
    expect(applicability.valid).toBe(false);
    expect(applicability.message).toContain("opposite applicability");
  });

  it("requires a reason for an AaaS SHOULD exception", () => {
    const results = NODE_L2_CASES.map((c) => ({
      id: c.id,
      result:
        c.id.startsWith("TC-N2-AaaS-") ||
        c.id.startsWith("TC-N2-Anchor") ||
        c.id === "TC-N2-HA-09"
          ? "pass"
          : "na",
    }));
    results.find((c) => c.id === "TC-N2-AaaS-06")!.result = "na";
    const missingReason = createConformanceManifest({
      profile: NODE_L2,
      iutName: "service",
      iutVersion: "0.1.0",
      iutNid: "urn:nps:node:example.test:anchor-1",
      peerName: "reference",
      peerVersion: "1.0.0-alpha.18",
      results,
    });
    expect(validateConformanceManifest(missingReason).message).toContain(
      "requires a non-empty message",
    );

    missingReason.cases.find((c) => c.id === "TC-N2-AaaS-06")!.message =
      "Synchronous-only deployment";
    expect(validateConformanceManifest(missingReason).valid).toBe(true);
  });
});
