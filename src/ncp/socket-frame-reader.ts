// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Buffering, length-aware frame reader for a `node:net` socket.
 *
 * Sockets deliver bytes in arbitrary chunks, so a native NCP transport needs a
 * reader that can (a) block until an exact number of bytes has arrived and
 * (b) peek the 2-byte frame header prefix to decide whether the header is 4 or
 * 8 bytes long. Mirrors the .NET `NcpNativeClient.ReadFrameHeaderAsync` /
 * `Stream.ReadExactlyAsync` behaviour.
 */

import type { Socket } from "node:net";
import {
  DEFAULT_HEADER_SIZE,
  EXTENDED_HEADER_SIZE,
  FrameFlags,
  FrameHeader,
} from "../core/frames.js";

/** Thrown when the peer closes the connection before enough bytes arrive. */
export class NcpStreamClosedError extends Error {
  constructor(needed: number, got: number) {
    super(`Stream closed before reading ${needed} bytes (got ${got}).`);
    this.name = "NcpStreamClosedError";
  }
}

export class SocketFrameReader {
  private readonly _socket: Socket;
  private _buffer: Uint8Array = new Uint8Array(0);
  /** Resolvers waiting for more data, in FIFO order. */
  private _pending: Array<() => void> = [];
  private _ended = false;
  private _error: Error | null = null;

  constructor(socket: Socket) {
    this._socket = socket;
    this._socket.on("data", (chunk: Buffer) => {
      this._append(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    this._socket.on("end", () => {
      this._ended = true;
      this._wakeAll();
    });
    this._socket.on("close", () => {
      this._ended = true;
      this._wakeAll();
    });
    this._socket.on("error", (err: Error) => {
      this._error = err;
      this._wakeAll();
    });
  }

  private _append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this._buffer.length + chunk.length);
    merged.set(this._buffer, 0);
    merged.set(chunk, this._buffer.length);
    this._buffer = merged;
    this._wakeAll();
  }

  private _wakeAll(): void {
    const waiters = this._pending;
    this._pending = [];
    for (const w of waiters) w();
  }

  /** Reads exactly `n` bytes, waiting for the socket as needed. */
  async readExactly(n: number): Promise<Uint8Array> {
    while (this._buffer.length < n) {
      if (this._error) throw this._error;
      if (this._ended) throw new NcpStreamClosedError(n, this._buffer.length);
      await new Promise<void>((resolve) => this._pending.push(resolve));
    }
    const out = this._buffer.slice(0, n);
    this._buffer = this._buffer.slice(n);
    return out;
  }

  /**
   * Reads a full frame header, peeking the EXT flag to decide whether to read 4
   * or 8 bytes total. Returns the parsed header plus the raw header bytes.
   * Mirrors `NcpNativeClient.ReadFrameHeaderAsync`.
   */
  async readFrameHeader(): Promise<{ header: FrameHeader; raw: Uint8Array }> {
    const peek = await this.readExactly(2);
    const ext = (peek[1]! & FrameFlags.EXT) !== 0;
    const remaining = ext
      ? EXTENDED_HEADER_SIZE - 2
      : DEFAULT_HEADER_SIZE - 2;
    const rest = await this.readExactly(remaining);

    const raw = new Uint8Array(peek.length + rest.length);
    raw.set(peek, 0);
    raw.set(rest, peek.length);

    return { header: FrameHeader.parse(raw), raw };
  }

  /** Reads a full frame (header + payload) and returns the concatenated wire bytes. */
  async readFrame(): Promise<{ header: FrameHeader; wire: Uint8Array }> {
    const { header, raw } = await this.readFrameHeader();
    const payload = await this.readExactly(header.payloadLength);
    const wire = new Uint8Array(raw.length + payload.length);
    wire.set(raw, 0);
    wire.set(payload, raw.length);
    return { header, wire };
  }
}
