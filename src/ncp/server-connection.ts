// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side representation of an inbound NCP connection that has passed the
 * preamble check and sent its HelloFrame. Call {@link accept} to complete the
 * handshake, or {@link reject} to send an error and close the connection.
 *
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpServerConnection.cs.
 */

import type { Socket } from "node:net";
import type { NpsFrameCodec } from "../core/codec.js";
import { EncodingTier } from "../core/frames.js";
import { HelloFrame, ErrorFrame, NcpHandshakeCapsFrame } from "./frames.js";
import { NcpEncodingPolicy } from "./encoding-policy.js";
import {
  negotiateHandshake,
  type NcpHandshakeProfile,
} from "./handshake-profile.js";
import { NpsFrameError } from "../core/exceptions.js";
import { NcpSession } from "./session.js";
import { SocketFrameReader } from "./socket-frame-reader.js";

export class NcpServerConnection {
  private readonly _socket: Socket;
  private readonly _reader: SocketFrameReader;
  private readonly _codec: NpsFrameCodec;

  /** The HelloFrame sent by the connecting client. */
  readonly clientHello: HelloFrame;

  constructor(
    socket: Socket,
    reader: SocketFrameReader,
    codec: NpsFrameCodec,
    clientHello: HelloFrame,
    private readonly _profile: NcpHandshakeProfile,
  ) {
    this._socket = socket;
    this._reader = reader;
    this._codec = codec;
    this.clientHello = clientHello;
  }

  /**
   * Sends `serverCaps` to the client and returns a live {@link NcpSession}.
   * The encoding policy is negotiated from the client's supported encodings; the
   * caps frame's negotiated_encoding / enabled_encodings fields are overwritten
   * with the negotiated values before being sent.
   */
  async accept(serverCaps: NcpHandshakeCapsFrame): Promise<NcpSession> {
    const negotiation = negotiateHandshake(this._profile, this.clientHello);
    if (negotiation.action !== "accept") {
      const error = negotiation.error ?? "NCP-VERSION-INCOMPATIBLE";
      await this.reject(new ErrorFrame(
        negotiation.status ?? "NPS-PROTO-VERSION-INCOMPATIBLE",
        error,
        "Native NCP handshake negotiation failed.",
      ));
      throw new NpsFrameError(
        `Native NCP handshake negotiation failed: ${error}`);
    }
    const defaultTier = negotiation.negotiatedEncoding === "msgpack"
      ? EncodingTier.MSGPACK
      : EncodingTier.JSON;
    const policy = new NcpEncodingPolicy(
      defaultTier,
      negotiation.enabledEncodings?.includes("binary_vector.v1") === true,
    );
    const caps = new NcpHandshakeCapsFrame(
      serverCaps.nodeId,
      serverCaps.caps,
      negotiation.negotiatedEncoding,
      negotiation.enabledEncodings,
      serverCaps.anchorRef,
      serverCaps.payload,
      negotiation.sessionVersion,
      negotiation.supportedProtocols,
      negotiation.maxFramePayload,
      negotiation.extSupport,
      negotiation.maxConcurrentStreams,
    );
    const wire = this._codec.encode(caps, { overrideTier: policy.defaultTier });
    await this._write(wire);
    return new NcpSession(this._socket, this._reader, this._codec, caps, policy);
  }

  /** Sends an ErrorFrame to reject the client and closes the connection. */
  async reject(error: ErrorFrame): Promise<void> {
    try {
      const wire = this._codec.encode(error, { overrideTier: EncodingTier.JSON });
      await this._write(wire);
    } finally {
      await this.dispose();
    }
  }

  /** Closes the underlying socket. */
  dispose(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this._socket.destroyed) {
        resolve();
        return;
      }
      this._socket.once("close", () => resolve());
      this._socket.end(() => this._socket.destroy());
    });
  }

  private _write(wire: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._socket.write(wire, (err) => (err ? reject(err) : resolve()));
    });
  }
}
