// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EncodingTier,
  FrameFlags,
  FrameHeader,
  FrameType,
} from "../src/core/frames.js";
import { HelloFrame } from "../src/ncp/frames.js";
import {
  evaluateHelloHeader,
  evaluatePreamble,
  negotiateHandshake,
  type NcpHandshakeDecision,
  type NcpHandshakeProfile,
} from "../src/ncp/handshake-profile.js";
import { NipCaClient, type NipCaCrl } from "../src/nip/ca-client.js";
import {
  NipRevocationEvaluation,
  type NipRevocationMode,
  type NipRevocationOutcome,
  type NipRevocationSource,
} from "../src/nip/revocation-policy.js";
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

describe("Alpha.17 shared portable profiles", () => {
  it("passes every NCP native-server handshake vector", () => {
    const tiers: Record<string, EncodingTier> = {
      json: EncodingTier.JSON,
      msgpack: EncodingTier.MSGPACK,
      binary_vector: EncodingTier.BINARY_VECTOR,
    };
    for (const vector of vectors(
      "spec/conformance/ncp/native_server_handshake_vectors.json",
    )) {
      const server = vector.input.server;
      const transport = vector.input.transport;
      const expected = vector.expected;
      let decision: NcpHandshakeDecision = evaluatePreamble(
        Buffer.from(transport.preamble_hex, "hex"),
        transport.preamble_elapsed_ms,
        server.preamble_timeout_ms,
      );
      if (decision.action === "continue" && transport.first_frame_type) {
        let flags = tiers[transport.first_frame_tier]!;
        if (transport.first_frame_encrypted) flags |= FrameFlags.ENCRYPTED;
        if (transport.first_frame_extended) flags |= FrameFlags.EXT;
        decision = evaluateHelloHeader(
          new FrameHeader(
            Number.parseInt(transport.first_frame_type, 16) as FrameType,
            flags,
            transport.hello_payload_length,
          ),
          transport.hello_elapsed_ms,
          server.hello_timeout_ms,
          server.max_hello_payload,
        );
      }
      if (decision.action === "continue" && vector.input.hello) {
        const profile: NcpHandshakeProfile = {
          minVersion: server.min_version,
          npsVersion: server.nps_version,
          supportedEncodings: server.supported_encodings,
          supportedProtocols: server.supported_protocols,
          maxFramePayload: server.max_frame_payload,
          extSupport: server.ext_support,
          maxConcurrentStreams: server.max_concurrent_streams,
        };
        const hello = vector.input.hello;
        decision = negotiateHandshake(
          profile,
          new HelloFrame(
            hello.nps_version,
            hello.supported_encodings,
            hello.supported_protocols,
            hello.min_version,
            undefined,
            hello.max_frame_payload,
            hello.ext_support,
            hello.max_concurrent_streams,
          ),
        );
      }

      expect(decision.action, vector.id).toBe(expected.action);
      expect(decision.action === "error_close", vector.id).toBe(
        expected.emit_error,
      );
      const fieldMap: Record<string, keyof NcpHandshakeDecision> = {
        diagnostic_error: "diagnosticError",
        status: "status",
        error: "error",
        session_version: "sessionVersion",
        negotiated_encoding: "negotiatedEncoding",
        enabled_encodings: "enabledEncodings",
        supported_protocols: "supportedProtocols",
        max_frame_payload: "maxFramePayload",
        ext_support: "extSupport",
        max_concurrent_streams: "maxConcurrentStreams",
      };
      for (const [wire, field] of Object.entries(fieldMap)) {
        if (wire in expected) {
          expect(decision[field], `${vector.id} ${wire}`).toEqual(
            expected[wire],
          );
        }
      }
    }
  });

  it("passes every NIP revocation policy vector", () => {
    for (const vector of vectors(
      "spec/conformance/nip/revocation_policy_vectors.json",
    )) {
      const input = vector.input;
      const expected = vector.expected;
      const evaluation = new NipRevocationEvaluation(
        input.revocation_mode as NipRevocationMode,
        input.ocsp_fail_open,
      );
      let decision;
      for (const observation of input.sources) {
        decision = evaluation.observe(
          observation.source as NipRevocationSource,
          observation.outcome as NipRevocationOutcome,
        );
        if (decision) break;
      }
      decision ??= evaluation.complete();
      expect(decision.valid, vector.id).toBe(expected.valid);
      expect(evaluation.consultedSources, vector.id).toEqual(
        expected.consulted_sources,
      );
      if (!expected.valid) {
        expect(decision.stepFailed, vector.id).toBe(expected.failed_step);
        expect(decision.errorCode, vector.id).toBe(expected.error);
      }
    }
  });

  it("passes every NIP signed CRL vector", () => {
    for (const vector of vectors(
      "spec/conformance/nip/signed_crl_vectors.json",
    )) {
      const crl = {
        ...vector.input.body,
        signature: vector.input.signature,
      } as NipCaCrl;
      expect(
        NipCaClient.verifyCrlSignature(crl, vector.input.public_key),
        vector.id,
      ).toBe(vector.expected.signature_valid);
    }
  });
});
