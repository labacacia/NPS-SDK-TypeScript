// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NCP native-mode TCP client. Performs the 3-step handshake
 * (preamble → HelloFrame → NcpHandshakeCapsFrame) per NPS-1 §4.6 and returns a
 * live {@link NcpSession}.
 *
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpNativeClient.cs. Uses Node's
 * `node:net` Socket as the transport (native NCP is inherently socket-based;
 * the SDK's HTTP paths use fetch, but native mode needs raw TCP).
 */

import * as net from "node:net";
import { NpsFrameCodec } from "../core/codec.js";
import { EncodingTier, FrameType } from "../core/frames.js";
import { FrameRegistry } from "../core/registry.js";
import { NpsError } from "../core/exceptions.js";
import { HelloFrame, ErrorFrame, NcpHandshakeCapsFrame } from "./frames.js";
import { NcpEncodingPolicy } from "./encoding-policy.js";
import { NcpSession } from "./session.js";
import { SocketFrameReader } from "./socket-frame-reader.js";
import { PREAMBLE_BYTES } from "./preamble.js";

/** Thrown when the server rejects the handshake or replies with an unexpected frame. */
export class NcpHandshakeError extends NpsError {
  readonly error: string;

  constructor(error: string, message?: string) {
    super(message ?? error);
    this.name = "NcpHandshakeError";
    this.error = error;
  }
}

/** Handshake-only registry: Caps → NcpHandshakeCapsFrame, Error → ErrorFrame. */
function buildHandshakeRegistry(): FrameRegistry {
  const r = new FrameRegistry();
  r.register(FrameType.CAPS, NcpHandshakeCapsFrame);
  r.register(FrameType.ERROR, ErrorFrame);
  return r;
}

export class NcpNativeClient {
  private readonly _codec: NpsFrameCodec;
  private readonly _handshakeCodec: NpsFrameCodec;

  /** @param codec Codec used to encode the outbound HelloFrame. */
  constructor(codec: NpsFrameCodec) {
    this._codec = codec;
    this._handshakeCodec = new NpsFrameCodec(buildHandshakeRegistry());
  }

  /**
   * Opens a TCP connection, performs the NCP native-mode handshake, and returns
   * a live session.
   *
   * @throws {NcpHandshakeError} Server rejected the handshake or sent an unexpected frame.
   */
  async connect(host: string, port: number, hello: HelloFrame): Promise<NcpSession> {
    const socket = await this._openSocket(host, port);
    const reader = new SocketFrameReader(socket);

    try {
      // 1 — preamble (encoding not yet negotiated)
      await this._write(socket, PREAMBLE_BYTES);

      // 2 — HelloFrame (ALWAYS Tier-1 JSON per spec — encoding not yet agreed)
      const helloWire = this._codec.encode(hello, { overrideTier: EncodingTier.JSON });
      await this._write(socket, helloWire);

      // 3 — read server response header (handles EXT 4/8-byte flag)
      const { header, wire } = await reader.readFrame();

      // 4/5 — ErrorFrame → throw
      if (header.frameType === FrameType.ERROR) {
        const err = this._handshakeCodec.decode(wire) as ErrorFrame;
        throw new NcpHandshakeError(err.error, err.message);
      }

      if (header.frameType !== FrameType.CAPS) {
        throw new NcpHandshakeError(
          "NCP-HANDSHAKE-UNEXPECTED-FRAME",
          `Expected CapsFrame (0x${FrameType.CAPS.toString(16).padStart(2, "0")}), ` +
            `got 0x${header.frameType.toString(16).padStart(2, "0")}.`,
        );
      }

      // 6 — decode NcpHandshakeCapsFrame using the negotiated tier the server
      // signalled as the stable default in the response header flags.
      const negotiatedTier = header.encodingTier;
      const caps = this._handshakeCodec.decode(wire) as NcpHandshakeCapsFrame;
      const policy = NcpEncodingPolicy.fromEnabledEncodings(negotiatedTier, caps.enabledEncodings);

      return new NcpSession(socket, reader, this._codec, caps, policy);
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private _openSocket(host: string, port: number): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect({ host, port });
      const onError = (e: Error): void => {
        socket.destroy();
        reject(e);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        resolve(socket);
      });
    });
  }

  private _write(socket: net.Socket, wire: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      socket.write(wire, (err) => (err ? reject(err) : resolve()));
    });
  }
}
