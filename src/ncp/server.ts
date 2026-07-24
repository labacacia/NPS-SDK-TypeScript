// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * NCP native-mode TCP server. Listens on a configured endpoint, validates the
 * connection preamble, reads the client's HelloFrame, and returns an
 * {@link NcpServerConnection} for the application to accept or reject (NPS-1 §4.6).
 *
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpServer.cs. Uses Node's
 * `node:net` Server as the listener.
 */

import * as net from "node:net";
import type { NpsFrameCodec } from "../core/codec.js";
import { FrameType } from "../core/frames.js";
import { NpsFrameError } from "../core/exceptions.js";
import { HelloFrame } from "./frames.js";
import { validatePreamble, PREAMBLE_LENGTH } from "./preamble.js";
import { NcpServerConnection } from "./server-connection.js";
import { SocketFrameReader } from "./socket-frame-reader.js";
import {
  type NcpServerOptions,
  resolveServerOptions,
} from "./server-options.js";

export class NcpServer {
  private readonly _server: net.Server;
  private readonly _codec: NpsFrameCodec;
  private readonly _options: ReturnType<typeof resolveServerOptions>;

  /** Successfully-handshaken connections waiting to be handed to acceptConnection(). */
  private readonly _ready: NcpServerConnection[] = [];
  /** Callers of acceptConnection() waiting for the next ready connection. */
  private readonly _waiters: Array<{
    resolve: (c: NcpServerConnection) => void;
    reject: (e: Error) => void;
  }> = [];
  private _listenError: Error | null = null;
  /** Live accepted sockets, so stop() can force them closed. */
  private readonly _sockets = new Set<net.Socket>();

  constructor(codec: NpsFrameCodec, options?: NcpServerOptions) {
    this._codec = codec;
    this._options = resolveServerOptions(options);
    this._server = net.createServer((socket) => {
      this._sockets.add(socket);
      socket.once("close", () => this._sockets.delete(socket));
      void this._handleConnection(socket);
    });
    this._server.on("error", (err) => {
      this._listenError = err;
      this._failAllWaiters(err);
    });
  }

  /** Starts the listener. Resolves with the bound port. */
  start(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this._server.once("error", reject);
      this._server.listen(port, host, () => {
        this._server.removeListener("error", reject);
        const addr = this._server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        resolve(boundPort);
      });
    });
  }

  /**
   * Stops the listener, releases the port binding, and force-closes any
   * still-open accepted connections. (.NET's Stop() only halts the listener,
   * but Node's Server.close() will not resolve while sockets remain open.)
   */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      for (const s of this._sockets) s.destroy();
      this._sockets.clear();
      this._server.close(() => resolve());
    });
  }

  /**
   * Returns the next inbound connection whose preamble was valid and which sent
   * a well-formed HelloFrame. Mirrors .NET's AcceptConnectionAsync.
   */
  acceptConnection(): Promise<NcpServerConnection> {
    if (this._listenError) return Promise.reject(this._listenError);
    const ready = this._ready.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise<NcpServerConnection>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  private _deliver(conn: NcpServerConnection): void {
    const waiter = this._waiters.shift();
    if (waiter) waiter.resolve(conn);
    else this._ready.push(conn);
  }

  private _failAllWaiters(err: Error): void {
    while (this._waiters.length > 0) {
      this._waiters.shift()!.reject(err);
    }
  }

  private async _handleConnection(rawSocket: net.Socket): Promise<void> {
    let socket = rawSocket;
    try {
      socket = await this._authenticate(socket);

      const reader = new SocketFrameReader(socket);
      const readWork = this._readHandshake(socket, reader);
      const conn =
        this._options.handshakeReadTimeoutMs > 0
          ? await withTimeout(
              readWork,
              this._options.handshakeReadTimeoutMs,
              "NCP handshake read timed out.",
            )
          : await readWork;
      this._deliver(conn);
    } catch {
      // A failed handshake closes the individual connection but does not tear
      // down the listener. .NET disposes the stream/socket on any failure here.
      socket.destroy();
    }
  }

  private async _authenticate(socket: net.Socket): Promise<net.Socket> {
    if (!this._options.authenticateStream) {
      if (this._options.requireAuthenticatedStream) {
        throw new NpsFrameError(
          "NcpServerOptions.requireAuthenticatedStream is true, but no authenticateStream hook is configured.",
        );
      }
      return socket;
    }

    const authenticated = await this._options.authenticateStream(socket);
    if (this._options.requireAuthenticatedStream && authenticated === socket) {
      throw new NpsFrameError(
        "NCP stream authentication hook returned the original socket while requireAuthenticatedStream is true.",
      );
    }
    return authenticated;
  }

  private async _readHandshake(
    socket: net.Socket,
    reader: SocketFrameReader,
  ): Promise<NcpServerConnection> {
    // 1 — read & validate preamble.
    const preamble = await reader.readExactly(PREAMBLE_LENGTH);
    validatePreamble(preamble);

    // 2 — read frame header.
    const { header } = await reader.readFrameHeader();

    if (header.frameType !== FrameType.HELLO) {
      throw new NpsFrameError(
        `Expected HelloFrame (0x${FrameType.HELLO.toString(16).padStart(2, "0")}) as first frame ` +
          `after preamble, got 0x${header.frameType.toString(16).padStart(2, "0")}.`,
      );
    }

    if (header.payloadLength > this._options.maxHelloPayload) {
      throw new NpsFrameError(
        `HelloFrame payload length ${header.payloadLength} exceeds configured maximum ` +
          `${this._options.maxHelloPayload} bytes.`,
      );
    }

    // 3 — read payload and rebuild the full wire frame for the codec.
    const payload = await reader.readExactly(header.payloadLength);
    const wire = new Uint8Array(header.headerSize + payload.length);
    wire.set(header.toBytes(), 0);
    wire.set(payload, header.headerSize);

    const hello = this._codec.decode(wire);
    if (!(hello instanceof HelloFrame)) {
      throw new NpsFrameError("First frame after preamble did not decode to a HelloFrame.");
    }

    return new NcpServerConnection(socket, reader, this._codec, hello);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NpsFrameError(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
