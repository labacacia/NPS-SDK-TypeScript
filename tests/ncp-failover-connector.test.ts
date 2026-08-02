// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// NPS-CR-0009 §3.3 — native-path failover reconnect.
// Port of tests/NPS.Tests/Ncp/NcpFailoverConnectorTests.cs (brief A §5.3).

import { describe, expect, it } from "vitest";
import { NpsError } from "../src/core/exceptions.js";
import {
  NcpFailoverConnector,
  isFailoverShaped,
  type AnchorEndpoint,
} from "../src/ncp/failover-connector.js";
import { NCP_ERROR_CODES } from "../src/ncp/ncp-error-codes.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface FakeSession { host: string; port: number }

/** An NPS protocol error, in the shape this SDK's error carriers use. */
class NpsProtocolError extends NpsError {
  constructor(public readonly protocolErrorCode: string, message?: string) {
    super(message ?? protocolErrorCode);
    this.name = "NpsProtocolError";
  }
}

/** A Node system error, as a real socket failure arrives. */
function socketError(code: string): Error & { code: string; syscall: string; errno: number } {
  return Object.assign(new Error(`connect ${code}`), {
    code, syscall: "connect", errno: -111,
  });
}

/** A resolver handing out a queued sequence of endpoints, counting its calls. */
function queuedResolver(...endpoints: AnchorEndpoint[]) {
  const queue = [...endpoints];
  let calls = 0;
  return {
    resolve: (): AnchorEndpoint => {
      calls++;
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
    get calls() { return calls; },
    get remaining() { return queue.length; },
  };
}

// ── Failover shape ───────────────────────────────────────────────────────────

describe("isFailoverShaped", () => {
  it("matches socket / IO errors", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "EPIPE"]) {
      expect(isFailoverShaped(socketError(code)), code).toBe(true);
    }
  });

  it("matches an NPS error carrying NCP-NID-MISMATCH", () => {
    expect(isFailoverShaped(new NpsProtocolError(NCP_ERROR_CODES.NCP_NID_MISMATCH))).toBe(true);
  });

  it("matches an AggregateError whose members are all failover-shaped", () => {
    expect(isFailoverShaped(new AggregateError([socketError("ECONNREFUSED"), socketError("ETIMEDOUT")])))
      .toBe(true);
  });

  it("does NOT match other NPS protocol errors or plain errors", () => {
    expect(isFailoverShaped(new NpsProtocolError(NCP_ERROR_CODES.NCP_FRAME_FLAGS_INVALID))).toBe(false);
    expect(isFailoverShaped(new Error("boom"))).toBe(false);
    expect(isFailoverShaped("nope")).toBe(false);
    expect(isFailoverShaped(null)).toBe(false);
  });
});

// ── The connector ────────────────────────────────────────────────────────────

describe("NcpFailoverConnector (NPS-CR-0009 §3.3)", () => {
  it("re-resolves and reconnects after NCP-NID-MISMATCH", async () => {
    const r = queuedResolver(
      { host: "old-anchor", port: 17433 },
      { host: "new-anchor", port: 17433 },
    );
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: r.resolve,
      connect: (host, port) => {
        if (host === "old-anchor") throw new NpsProtocolError(NCP_ERROR_CODES.NCP_NID_MISMATCH);
        return { host, port };
      },
    });
    const session = await connector.connect();
    expect(session).toEqual({ host: "new-anchor", port: 17433 });
    expect(r.calls).toBe(2);          // BOTH resolutions consumed
    expect(r.remaining).toBe(1);
  });

  it("re-resolves after a socket loss", async () => {
    const r = queuedResolver({ host: "anchor-1", port: 1 }, { host: "anchor-2", port: 2 });
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: r.resolve,
      connect: async (host, port) => {
        if (host === "anchor-1") throw socketError("ECONNREFUSED");
        return { host, port };
      },
    });
    expect((await connector.connect()).host).toBe("anchor-2");
    expect(r.calls).toBe(2);          // exactly two resolutions
  });

  it("propagates a non-failover error immediately, unwrapped, after ONE resolution", async () => {
    const r = queuedResolver({ host: "a", port: 1 });
    const boom = new NpsProtocolError(NCP_ERROR_CODES.NCP_FRAME_FLAGS_INVALID);
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: r.resolve,
      connect: () => { throw boom; },
      maxAttempts: 5,
    });
    await expect(connector.connect()).rejects.toBe(boom);   // same instance, not wrapped
    expect(r.calls).toBe(1);
  });

  it("rethrows the LAST failure once attempts are exhausted, preserving its type", async () => {
    const r = queuedResolver({ host: "a", port: 1 });
    let attempts = 0;
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: r.resolve,
      connect: () => { throw Object.assign(socketError("ETIMEDOUT"), { attempt: ++attempts }); },
      maxAttempts: 3,
    });
    const err = await connector.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // the LAST failure, with its original (socket) type and payload intact
    expect((err as { code: string }).code).toBe("ETIMEDOUT");
    expect((err as { attempt: number }).attempt).toBe(3);
    expect(r.calls).toBe(3);
  });

  it("re-resolves on EVERY attempt, including the first", async () => {
    const r = queuedResolver({ host: "a", port: 1 });
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: r.resolve,
      connect: (host, port) => ({ host, port }),
    });
    await connector.connect();
    expect(r.calls).toBe(1);          // one attempt ⇒ one resolution, before connecting
  });

  it("composes with an injected successor_nid resolution — it has no NDP dependency", async () => {
    // The resolver is where NDP highest-epoch resolution or an anchor_failover successor
    // would be plugged in; the connector never reaches for either itself.
    let successor: AnchorEndpoint = { host: "anchor-a", port: 17433 };
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: () => successor,
      connect: (host, port) => {
        if (host === "anchor-a") {
          successor = { host: "anchor-b", port: 17433 };   // an anchor_failover arrived
          throw new NpsProtocolError(NCP_ERROR_CODES.NCP_NID_MISMATCH);
        }
        return { host, port };
      },
    });
    expect((await connector.connect()).host).toBe("anchor-b");
  });

  it("validates its constructor arguments", () => {
    const ok = { resolveActive: () => ({ host: "a", port: 1 }), connect: () => ({}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new NcpFailoverConnector({ ...ok, resolveActive: undefined } as any)).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new NcpFailoverConnector({ ...ok, connect: undefined } as any)).toThrow(TypeError);
    expect(() => new NcpFailoverConnector({ ...ok, maxAttempts: 0 })).toThrow(RangeError);
    expect(new NcpFailoverConnector(ok).maxAttempts).toBe(2);   // default
  });

  it("honours an abort signal before each attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: () => ({ host: "a", port: 1 }),
      connect: (host, port) => ({ host, port }),
    });
    await expect(connector.connect(controller.signal)).rejects.toThrow();
  });

  it("accepts a custom failover-shape matcher", async () => {
    class WeirdTransportError extends Error {}
    let attempts = 0;
    const connector = new NcpFailoverConnector<FakeSession>({
      resolveActive: () => ({ host: "a", port: 1 }),
      connect: (host, port) => {
        if (attempts++ === 0) throw new WeirdTransportError("retry me");
        return { host, port };
      },
      isFailoverShaped: (e) => e instanceof WeirdTransportError,
    });
    expect((await connector.connect()).host).toBe("a");
    expect(attempts).toBe(2);
  });
});
