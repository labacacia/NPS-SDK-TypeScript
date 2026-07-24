// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * A live NCP native-mode session established after a successful handshake.
 * Wraps the underlying TCP socket and exposes the negotiated parameters.
 *
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpSession.cs. Adds send/receive
 * frame helpers that enforce the negotiated encoding policy — the .NET session
 * exposes the raw stream for upper layers; here we surface both the raw socket
 * (via {@link getSocket}) and typed frame I/O bound to the session policy.
 */

import type { Socket } from "node:net";
import type { NpsFrameCodec, NpsFrame } from "../core/codec.js";
import { EncodingTier, FrameHeader } from "../core/frames.js";
import type { NcpHandshakeCapsFrame } from "./frames.js";
import type { NcpEncodingPolicy } from "./encoding-policy.js";
import { SocketFrameReader } from "./socket-frame-reader.js";

export class NcpSession {
  private readonly _socket: Socket;
  private readonly _reader: SocketFrameReader;
  private readonly _codec: NpsFrameCodec;

  /** Capabilities the server advertised during the handshake. */
  readonly serverCaps: NcpHandshakeCapsFrame;

  /** Encoding policy negotiated during the handshake. */
  readonly encodingPolicy: NcpEncodingPolicy;

  constructor(
    socket: Socket,
    reader: SocketFrameReader,
    codec: NpsFrameCodec,
    serverCaps: NcpHandshakeCapsFrame,
    encodingPolicy: NcpEncodingPolicy,
  ) {
    this._socket = socket;
    this._reader = reader;
    this._codec = codec;
    this.serverCaps = serverCaps;
    this.encodingPolicy = encodingPolicy;
  }

  /** Stable default encoding tier negotiated during the handshake. */
  get negotiatedTier(): EncodingTier {
    return this.encodingPolicy.defaultTier;
  }

  /** True while the underlying TCP connection is still open. */
  get isConnected(): boolean {
    return !this._socket.destroyed && this._socket.writable;
  }

  /**
   * Returns the raw transport socket for upper-layer protocol use.
   * The socket is owned by this session — do not destroy it directly.
   */
  getSocket(): Socket {
    return this._socket;
  }

  /**
   * Encodes and sends a frame using the negotiated policy. Defaults to the
   * negotiated stable tier; an explicit tier is validated against the policy.
   */
  async send(frame: NpsFrame, tier?: EncodingTier): Promise<void> {
    const useTier = tier ?? this.negotiatedTier;
    const wire = this._codec.encode(frame, { overrideTier: useTier });
    // Validate against the negotiated policy before it leaves the wire.
    this.encodingPolicy.ensureAllows(FrameHeader.parse(wire));
    await this._write(wire);
  }

  /** Reads the next frame, enforcing the negotiated encoding policy. */
  async receive(): Promise<NpsFrame> {
    const { header, wire } = await this._reader.readFrame();
    this.encodingPolicy.ensureAllows(header);
    return this._codec.decode(wire);
  }

  private _write(wire: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._socket.write(wire, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Closes the session and its underlying socket. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this._socket.destroyed) {
        resolve();
        return;
      }
      this._socket.once("close", () => resolve());
      this._socket.end(() => this._socket.destroy());
    });
  }
}
