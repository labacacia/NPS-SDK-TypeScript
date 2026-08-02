// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

export const NODE_L1 = "NPS-Node-L1" as const;
export const NODE_L2 = "NPS-Node-L2" as const;

export interface NpsConformanceCase {
  id:          string;
  profile:     string;
  requirement: string;
  title:       string;
  optional:    boolean;
}

export interface NpsConformanceCaseResult {
  id:       string;
  result:   "pass" | "fail" | "skip" | "na" | string;
  message?: string;
}

export interface NpsConformanceActor {
  name:     string;
  version:  string;
  nid?:     string;
}

export interface NpsConformanceManifest {
  profile:         string;
  profile_version: string;
  iut:             NpsConformanceActor;
  peer:            NpsConformanceActor;
  run:             { date: string; environment: string };
  cases:           readonly NpsConformanceCaseResult[];
  summary:         { pass: number; fail: number; skip: number; na: number };
}

export interface NpsConformanceValidation {
  valid:   boolean;
  message: string;
}

export function createConformanceManifest(args: {
  profile: string;
  iutName: string;
  iutVersion: string;
  iutNid: string;
  peerName: string;
  peerVersion: string;
  results: readonly NpsConformanceCaseResult[];
  environment?: string;
}): NpsConformanceManifest {
  const cases = [...args.results];
  return {
    profile: args.profile,
    profile_version: args.profile === NODE_L2 ? "0.3" : "0.1",
    iut: { name: args.iutName, version: args.iutVersion, nid: args.iutNid },
    peer: { name: args.peerName, version: args.peerVersion },
    run: { date: new Date().toISOString(), environment: args.environment ?? "unspecified" },
    cases,
    summary: {
      pass: cases.filter((c) => c.result === "pass").length,
      fail: cases.filter((c) => c.result === "fail").length,
      skip: cases.filter((c) => c.result === "skip").length,
      na: cases.filter((c) => c.result === "na").length,
    },
  };
}

export function catalogForProfile(profile: string): readonly NpsConformanceCase[] {
  if (profile === NODE_L1) return NODE_L1_CASES;
  if (profile === NODE_L2) return NODE_L2_CASES;
  throw new RangeError(`Unknown NPS conformance profile: ${profile}`);
}

export function validateConformanceManifest(manifest: NpsConformanceManifest): NpsConformanceValidation {
  const catalog = catalogForProfile(manifest.profile);
  const known = new Map(catalog.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const validResults = new Set(["pass", "fail", "skip", "na"]);

  for (const result of manifest.cases) {
    const knownCase = known.get(result.id);
    if (knownCase === undefined) return { valid: false, message: `Unknown conformance case id '${result.id}'.` };
    if (seen.has(result.id)) return { valid: false, message: `Duplicate conformance case id '${result.id}'.` };
    seen.add(result.id);
    if (!validResults.has(result.result)) {
      return { valid: false, message: `Case '${result.id}' has invalid result '${result.result}'.` };
    }
    if (result.result === "na" && !knownCase.optional) {
      return { valid: false, message: `Case '${result.id}' is required and cannot be marked na.` };
    }
  }

  const missing = catalog.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (missing.length > 0) {
    return { valid: false, message: `Missing conformance case results: ${missing.join(", ")}.` };
  }
  if (manifest.cases.some((c) => c.result === "fail" || c.result === "skip")) {
    return { valid: false, message: "Conformance manifest contains fail or skip results." };
  }
  return { valid: true, message: "Conformance manifest is valid." };
}

function c(id: string, profile: string, requirement: string, title: string, optional = false): NpsConformanceCase {
  return { id, profile, requirement, title, optional };
}

export const NODE_L1_CASES: readonly NpsConformanceCase[] = [
  c("TC-N1-NCP-01", NODE_L1, "N1-NCP-01", "Tier-1 JSON frame round-trip"),
  c("TC-N1-NCP-02", NODE_L1, "N1-NCP-02", "Hello + Anchor handshake"),
  c("TC-N1-NCP-03", NODE_L1, "N1-NCP-03", "Loopback listener default"),
  c("TC-N1-NCP-04", NODE_L1, "N1-NCP-04", "Tier-2 negotiation hygiene"),
  c("TC-N1-NIP-01", NODE_L1, "N1-NIP-01", "Root keypair generation and permission"),
  c("TC-N1-NIP-02", NODE_L1, "N1-NIP-02", "IdentFrame sign and verify"),
  c("TC-N1-NIP-03", NODE_L1, "N1-NIP-03", "NID format"),
  c("TC-N1-NIP-04", NODE_L1, "N1-NIP-04", "Sub-NID issuance", true),
  c("TC-N1-NDP-01", NODE_L1, "N1-NDP-01", "AnnounceFrame carries activation_mode"),
  c("TC-N1-NDP-02", NODE_L1, "N1-NDP-02", "AnnounceFrame signature"),
  c("TC-N1-NDP-03", NODE_L1, "N1-NDP-03", "ResolveFrame response"),
  c("TC-N1-NDP-04", NODE_L1, "N1-NDP-04", "GraphFrame topology snapshot", true),
  c("TC-N1-NWP-01", NODE_L1, "N1-NWP-01", "Inbox accepts ActionFrame"),
  c("TC-N1-NWP-02", NODE_L1, "N1-NWP-02", "Inbox persists across restart"),
  c("TC-N1-NWP-03", NODE_L1, "N1-NWP-03", "NWP pull serves inbox"),
  c("TC-N1-NWP-04", NODE_L1, "N1-NWP-04", "100 QPS baseline"),
  c("TC-N1-NWP-05", NODE_L1, "N1-NWP-05", "Push path", true),
  c("TC-N1-OBS-01", NODE_L1, "N1-OBS-01", "Frame log entry per direction"),
  c("TC-N1-OBS-02", NODE_L1, "N1-OBS-02", "Log entry fields"),
  c("TC-N1-OBS-03", NODE_L1, "N1-OBS-03", "Log destination flexibility"),
];

export const NODE_L2_CASES: readonly NpsConformanceCase[] = [
  c("TC-N2-AnchorTopo-01", NODE_L2, "L2-08", "Snapshot of a 3-member cluster"),
  c("TC-N2-AnchorTopo-02", NODE_L2, "L2-08", "Version monotonicity across joins"),
  c("TC-N2-AnchorTopo-03", NODE_L2, "L2-08", "Sub-Anchor member surfaces"),
  c("TC-N2-AnchorStream-01", NODE_L2, "L2-08", "member_joined on NDP Announce"),
  c("TC-N2-AnchorStream-02", NODE_L2, "L2-08", "member_left on NDP TTL expiry"),
  c("TC-N2-AnchorStream-03", NODE_L2, "L2-08", "Resume from topology.since_version"),
  c("TC-N2-AnchorTopo-04", NODE_L2, "L2-08", "Unauthorized topology access"),
  c("TC-N2-AnchorTopo-05", NODE_L2, "L2-08", "Depth cap exceeded"),
  c("TC-N2-AnchorTopo-06", NODE_L2, "L2-08", "Unsupported topology scope"),
  c("TC-N2-AnchorTopo-07", NODE_L2, "L2-08", "Unsupported topology filter"),
  c("TC-N2-AnchorTopo-08", NODE_L2, "L2-08", "Unsupported reserved topology type"),
  c("TC-N2-AnchorStream-04", NODE_L2, "L2-08", "resync_required when version is too old"),
  c("TC-N2-Tls-01", NODE_L2, "NPS-RFC-0006", "ALPN nps/1.0 negotiated over TLS 1.3"),
  c("TC-N2-Tls-02", NODE_L2, "NPS-RFC-0006", "Mutual TLS required"),
  c("TC-N2-Tls-03", NODE_L2, "NPS-RFC-0006", "Client cert trust anchor and NID binding"),
  c("TC-N2-Tls-04", NODE_L2, "NPS-RFC-0006", "IdentFrame/certificate NID mismatch"),
  // NPS-CR-0010 §3.3 — inbound Bridge servers. Certification is per case family,
  // all-or-nothing: all six MUST pass for an IUT declaring a non-empty
  // `bridge_inbound_protocols`, and all six are `na` for an outbound-only or non-Bridge IUT.
  c("TC-N2-BridgeIn-01", NODE_L2, "NPS-CR-0010", "MCP inbound serves the full required method set"),
  c("TC-N2-BridgeIn-02", NODE_L2, "NPS-CR-0010", "gRPC inbound round-trip"),
  c("TC-N2-BridgeIn-03", NODE_L2, "NPS-CR-0010", "A2A inbound round-trip"),
  c("TC-N2-BridgeIn-04", NODE_L2, "NPS-CR-0010", "Bare action id resolves while ambiguity is rejected"),
  c("TC-N2-BridgeIn-05", NODE_L2, "NPS-CR-0010", "Error mapping matches the §16.3 table"),
  c("TC-N2-BridgeIn-06", NODE_L2, "NPS-CR-0010", "Undeclared protocol/direction is refused"),
  // NPS-CR-0009 §3.4 — multi-Anchor high availability.
  c("TC-N2-HA-01", NODE_L2, "NPS-CR-0009", "cluster_epoch carried on every topology read surface"),
  c("TC-N2-HA-02", NODE_L2, "NPS-CR-0009", "anchor_failover wire shape on planned handover"),
  c("TC-N2-HA-03", NODE_L2, "NPS-CR-0009", "anchor_failover on active loss is terminal"),
  c("TC-N2-HA-04", NODE_L2, "NPS-CR-0009", "anchor_quorum_lost wire shape and degraded read-only operation"),
  c("TC-N2-HA-05", NODE_L2, "NPS-CR-0009", "Standby Anchor rejects a topology write"),
  c("TC-N2-HA-06", NODE_L2, "NPS-CR-0009", "Superseded leader is fenced"),
  c("TC-N2-HA-07", NODE_L2, "NPS-CR-0009", "Registry resolves the highest-cluster_epoch Anchor"),
  c("TC-N2-HA-08", NODE_L2, "NPS-CR-0009", "Equal-epoch split-brain rejected"),
  c("TC-N2-HA-09", NODE_L2, "NPS-CR-0009", "Single-Anchor cluster stays at cluster_epoch = 1"),
];
