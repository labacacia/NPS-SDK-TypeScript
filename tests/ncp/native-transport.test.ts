// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0
//
// Drives the REAL NcpServer with the REAL NcpNativeClient over a loopback TCP
// socket, exercising the full NCP native-mode handshake (NPS-1 §4.6) ported
// from the .NET reference transport.

import { afterEach, describe, expect, it } from "vitest";
import { NpsFrameCodec } from "../../src/core/codec.js";
import { EncodingTier, FrameType, FrameHeader, FrameFlags } from "../../src/core/frames.js";
import { createFullRegistry } from "../../src/setup.js";
import {
  HelloFrame,
  ErrorFrame,
  NcpHandshakeCapsFrame,
} from "../../src/ncp/frames.js";
import { NcpNativeClient, NcpHandshakeError } from "../../src/ncp/native-client.js";
import { NcpServer } from "../../src/ncp/server.js";
import { NcpEncodingPolicy, NpsEncodingUnsupportedError } from "../../src/ncp/encoding-policy.js";
import { PATCH_FORMAT, isValidPatchFormat } from "../../src/ncp/ncp-patch-format.js";
import type { NcpSession } from "../../src/ncp/session.js";

function makeCodec(): NpsFrameCodec {
  return new NpsFrameCodec(createFullRegistry());
}

function makeHello(encodings: string[]): HelloFrame {
  return new HelloFrame("0.4", encodings, ["ncp", "nwp"]);
}

function serverCaps(): NcpHandshakeCapsFrame {
  return new NcpHandshakeCapsFrame("urn:nps:agent:test:node", ["ncp", "nwp"]);
}

describe("NCP native transport — loopback client/server", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function startServer(
    onConn: (conn: import("../../src/ncp/server-connection.js").NcpServerConnection) => Promise<void>,
  ): Promise<number> {
    const server = new NcpServer(makeCodec());
    const port = await server.start(0);
    cleanups.push(() => server.stop());
    void (async () => {
      try {
        const conn = await server.acceptConnection();
        await onConn(conn);
      } catch {
        /* server torn down between tests */
      }
    })();
    return port;
  }

  it("handshake happy path returns a live session (msgpack)", async () => {
    const port = await startServer(async (conn) => {
      expect(conn.clientHello.npsVersion).toBe("0.4");
      await conn.accept(serverCaps());
    });

    const client = new NcpNativeClient(makeCodec());
    const session = await client.connect("127.0.0.1", port, makeHello(["msgpack", "json"]));
    cleanups.push(() => session.close());

    expect(session.serverCaps.nodeId).toBe("urn:nps:agent:test:node");
    expect(session.negotiatedTier).toBe(EncodingTier.MSGPACK);
    expect(session.serverCaps.negotiatedEncoding).toBe("msgpack");
    expect(session.isConnected).toBe(true);
  });

  it("encoding negotiation falls back to json when msgpack is not offered", async () => {
    const port = await startServer(async (conn) => {
      await conn.accept(serverCaps());
    });

    const client = new NcpNativeClient(makeCodec());
    const session = await client.connect("127.0.0.1", port, makeHello(["json"]));
    cleanups.push(() => session.close());

    expect(session.negotiatedTier).toBe(EncodingTier.JSON);
    expect(session.encodingPolicy.enabledEncodings).toEqual(["json"]);
  });

  it("enables binary_vector extension when the client advertises it", async () => {
    const port = await startServer(async (conn) => {
      await conn.accept(serverCaps());
    });

    const client = new NcpNativeClient(makeCodec());
    const session = await client.connect(
      "127.0.0.1",
      port,
      makeHello(["msgpack", "json", "binary_vector.v1"]),
    );
    cleanups.push(() => session.close());

    expect(session.negotiatedTier).toBe(EncodingTier.MSGPACK);
    expect(session.encodingPolicy.binaryVectorEnabled).toBe(true);
    expect(session.serverCaps.enabledEncodings).toEqual(["msgpack", "binary_vector.v1"]);
  });

  it("server rejection surfaces as NcpHandshakeError with the error code", async () => {
    const port = await startServer(async (conn) => {
      await conn.reject(
        new ErrorFrame(
          "NPS-PROTO-VERSION-INCOMPATIBLE",
          "NCP-VERSION-INCOMPATIBLE",
          "server too old",
        ),
      );
    });

    const client = new NcpNativeClient(makeCodec());
    const err = await client
      .connect("127.0.0.1", port, makeHello(["msgpack"]))
      .then(
        () => {
          throw new Error("expected handshake to be rejected");
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(NcpHandshakeError);
    expect(err).toMatchObject({
      name: "NcpHandshakeError",
      error: "NCP-VERSION-INCOMPATIBLE",
      message: "server too old",
    });
  });

  it("live-session frame exchange over the negotiated policy", async () => {
    let serverSession: NcpSession | undefined;
    const port = await startServer(async (conn) => {
      serverSession = await conn.accept(serverCaps());
      // Echo one frame back to the client.
      const received = await serverSession.receive();
      expect(received.frameType).toBe(FrameType.ANCHOR);
      const { AnchorFrame } = await import("../../src/ncp/frames.js");
      await serverSession.send(
        new AnchorFrame("sha256:echo", { fields: [{ name: "id", type: "int" }] }),
      );
    });

    const client = new NcpNativeClient(makeCodec());
    const session = await client.connect("127.0.0.1", port, makeHello(["msgpack"]));
    cleanups.push(() => session.close());
    cleanups.push(async () => {
      if (serverSession) await serverSession.close();
    });

    const { AnchorFrame } = await import("../../src/ncp/frames.js");
    await session.send(
      new AnchorFrame("sha256:req", { fields: [{ name: "id", type: "int" }] }),
    );
    const reply = await session.receive();
    expect(reply.frameType).toBe(FrameType.ANCHOR);
    expect((reply as InstanceType<typeof AnchorFrame>).anchorId).toBe("sha256:echo");
  });
});

describe("EXT header round-trip through the socket frame reader", () => {
  it("peeks the 2-byte prefix to read 4- vs 8-byte headers", async () => {
    const net = await import("node:net");
    const { SocketFrameReader } = await import("../../src/ncp/socket-frame-reader.js");

    // Extended (EXT=1) header with a 5-byte payload, delivered in fragments.
    const extHeader = new FrameHeader(
      FrameType.ANCHOR,
      FrameFlags.EXT | FrameFlags.TIER1_JSON | FrameFlags.FINAL,
      5,
    ).toBytes();
    expect(extHeader.length).toBe(8);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const wire = new Uint8Array(extHeader.length + payload.length);
    wire.set(extHeader, 0);
    wire.set(payload, extHeader.length);

    const server = net.createServer((sock) => {
      // Fragment the wire to force the reader to buffer across chunks.
      sock.write(wire.slice(0, 1));
      sock.write(wire.slice(1, 3));
      sock.write(wire.slice(3));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const sock = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const reader = new SocketFrameReader(sock);

    const { header, wire: full } = await reader.readFrame();
    expect(header.isExtended).toBe(true);
    expect(header.headerSize).toBe(8);
    expect(header.payloadLength).toBe(5);
    expect(Array.from(full.slice(8))).toEqual([1, 2, 3, 4, 5]);

    sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("NcpEncodingPolicy", () => {
  it("allows the default tier and denies others", () => {
    const policy = new NcpEncodingPolicy(EncodingTier.MSGPACK);
    expect(policy.allows(EncodingTier.MSGPACK, FrameType.ANCHOR)).toBe(true);
    expect(policy.allows(EncodingTier.JSON, FrameType.ANCHOR)).toBe(false);
    expect(policy.allows(EncodingTier.BINARY_VECTOR, FrameType.QUERY)).toBe(false);
    expect(policy.enabledEncodings).toEqual(["msgpack"]);
  });

  it("permits BinaryVector only for Query frames when enabled", () => {
    const policy = new NcpEncodingPolicy(EncodingTier.MSGPACK, true);
    expect(policy.allows(EncodingTier.BINARY_VECTOR, FrameType.QUERY)).toBe(true);
    expect(policy.allows(EncodingTier.BINARY_VECTOR, FrameType.ANCHOR)).toBe(false);
    expect(policy.enabledEncodings).toEqual(["msgpack", "binary_vector.v1"]);
  });

  it("ensureAllows throws for a disallowed frame", () => {
    const policy = new NcpEncodingPolicy(EncodingTier.MSGPACK);
    const badHeader = new FrameHeader(FrameType.ANCHOR, FrameFlags.TIER1_JSON, 0);
    expect(() => policy.ensureAllows(badHeader)).toThrow(NpsEncodingUnsupportedError);
    const goodHeader = new FrameHeader(FrameType.ANCHOR, FrameFlags.TIER2_MSGPACK, 0);
    expect(() => policy.ensureAllows(goodHeader)).not.toThrow();
  });

  it("fromEnabledEncodings detects the binary_vector extension", () => {
    const p1 = NcpEncodingPolicy.fromEnabledEncodings(EncodingTier.JSON, ["json"]);
    expect(p1.binaryVectorEnabled).toBe(false);
    const p2 = NcpEncodingPolicy.fromEnabledEncodings(EncodingTier.MSGPACK, [
      "msgpack",
      "binary_vector.v1",
    ]);
    expect(p2.binaryVectorEnabled).toBe(true);
    expect(NcpEncodingPolicy.encodingToken(EncodingTier.BINARY_VECTOR)).toBe("binary_vector.v1");
  });
});

describe("NcpPatchFormat", () => {
  it("exposes the json_patch and binary_bitset constants", () => {
    expect(PATCH_FORMAT.JSON_PATCH).toBe("json_patch");
    expect(PATCH_FORMAT.BINARY_BITSET).toBe("binary_bitset");
  });

  it("validates known patch formats", () => {
    expect(isValidPatchFormat("json_patch")).toBe(true);
    expect(isValidPatchFormat("binary_bitset")).toBe(true);
    expect(isValidPatchFormat("nope")).toBe(false);
  });

  it("is re-exported from the core index", async () => {
    const core = await import("../../src/core/index.js");
    expect(core.PATCH_FORMAT.JSON_PATCH).toBe("json_patch");
    expect(core.isValidPatchFormat("binary_bitset")).toBe(true);
  });
});
