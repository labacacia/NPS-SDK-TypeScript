// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { NpsFrameCodec, type NpsFrame } from "../core/codec.js";
import { EncodingTier, FrameHeader, FrameType } from "../core/frames.js";
import { FrameRegistry } from "../core/registry.js";
import { CapsFrame, ErrorFrame } from "../ncp/frames.js";
import { registerNcpFrames } from "../ncp/registry.js";
import { ActionFrame, QueryFrame } from "./frames.js";
import { registerNwpFrames } from "./registry.js";

export interface NativeQueryResult {
  rows: readonly Record<string, unknown>[];
  nextCursor?: string | null;
}

export type NativeQueryHandler = (
  frame: QueryFrame,
) => Promise<CapsFrame | NativeQueryResult | readonly Record<string, unknown>[]> |
     CapsFrame | NativeQueryResult | readonly Record<string, unknown>[];

export type NativeActionHandler = (
  frame: ActionFrame,
) => Promise<NpsFrame | unknown> | NpsFrame | unknown;

export interface NwpNativeNodeServerOptions {
  codec?: NpsFrameCodec;
  registry?: FrameRegistry;
  tier?: EncodingTier;
  enabledEncodings?: readonly string[];
  anchorRef?: string;
  queryHandler?: NativeQueryHandler;
  actionHandler?: NativeActionHandler;
}

export interface NativeFrameSink {
  write(chunk: Uint8Array<ArrayBufferLike>): void | Promise<void>;
}

export class NwpNativeNodeServer {
  private readonly codec: NpsFrameCodec;
  private readonly tier: EncodingTier;
  private readonly enabledEncodings: readonly string[];
  private readonly anchorRef: string;
  private readonly queryHandler?: NativeQueryHandler;
  private readonly actionHandler?: NativeActionHandler;

  constructor(options: NwpNativeNodeServerOptions = {}) {
    const registry = options.registry ?? defaultNativeRegistry();
    this.codec = options.codec ?? new NpsFrameCodec(registry);
    this.tier = options.tier ?? EncodingTier.MSGPACK;
    this.enabledEncodings = options.enabledEncodings ?? [encodingToken(this.tier)];
    this.anchorRef = options.anchorRef ?? "native:nwp";
    this.queryHandler = options.queryHandler;
    this.actionHandler = options.actionHandler;
  }

  async dispatch(frame: NpsFrame): Promise<NpsFrame> {
    try {
      if (frame instanceof QueryFrame) return await this.dispatchQuery(frame);
      if (frame instanceof ActionFrame) return await this.dispatchAction(frame);
      return new ErrorFrame(
        "NPS-CLIENT-BAD-FRAME",
        "NWP-NATIVE-FRAME-UNSUPPORTED",
        `Native NWP server does not handle frame type 0x${frame.frameType.toString(16)}.`,
      );
    } catch (err) {
      return new ErrorFrame(
        "NPS-SERVER-INTERNAL",
        "NWP-NATIVE-DISPATCH-FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async dispatchWire(wire: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBufferLike>> {
    const policyError = encodingPolicyError(NpsFrameCodec.peekHeader(wire), this.tier, this.enabledEncodings);
    const response = policyError ?? await this.dispatch(this.codec.decode(wire));
    return this.codec.encode(response, { overrideTier: this.tier });
  }

  async serve(source: AsyncIterable<Uint8Array<ArrayBufferLike>>, sink: NativeFrameSink): Promise<void> {
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    for await (const chunk of source) {
      buffer = concat(buffer, chunk);
      while (buffer.length >= 4) {
        const header = FrameHeader.parse(buffer);
        const total = header.headerSize + header.payloadLength;
        if (buffer.length < total) break;
        await sink.write(await this.dispatchWire(owned(buffer.slice(0, total))));
        buffer = owned(buffer.slice(total));
      }
    }
    if (buffer.length !== 0) {
      throw new Error(`Native NWP stream ended with ${buffer.length} trailing bytes.`);
    }
  }

  private async dispatchQuery(frame: QueryFrame): Promise<CapsFrame> {
    if (this.queryHandler === undefined) {
      throw new Error("No native NWP query handler configured.");
    }
    return withRequestId(coerceQueryResult(await this.queryHandler(frame), this.anchorRef), frame.requestId);
  }

  private async dispatchAction(frame: ActionFrame): Promise<NpsFrame> {
    if (this.actionHandler === undefined) {
      throw new Error("No native NWP action handler configured.");
    }
    const result = await this.actionHandler(frame);
    if (result instanceof CapsFrame) return withRequestId(result, frame.requestId);
    if (isNpsFrame(result)) return result;
    if (result === undefined || result === null) return new CapsFrame(this.anchorRef, 0, [], undefined, undefined, undefined, undefined, frame.requestId);
    return new CapsFrame(this.anchorRef, 1, [result as Record<string, unknown>], undefined, undefined, undefined, undefined, frame.requestId);
  }
}

function defaultNativeRegistry(): FrameRegistry {
  const registry = new FrameRegistry();
  registerNcpFrames(registry);
  registerNwpFrames(registry);
  return registry;
}

function coerceQueryResult(
  result: CapsFrame | NativeQueryResult | readonly Record<string, unknown>[],
  anchorRef: string,
): CapsFrame {
  if (result instanceof CapsFrame) return result;
  if (Array.isArray(result)) {
    return new CapsFrame(anchorRef, result.length, result, undefined, estimateTokens(result), undefined, "native-estimate");
  }
  const native = result as NativeQueryResult;
  return new CapsFrame(
    anchorRef,
    native.rows.length,
    native.rows,
    native.nextCursor ?? undefined,
    estimateTokens(native.rows),
    undefined,
    "native-estimate",
  );
}

function isNpsFrame(value: unknown): value is NpsFrame {
  return typeof value === "object" && value !== null &&
    "frameType" in value && "preferredTier" in value && "toDict" in value;
}

function withRequestId(frame: CapsFrame, requestId: string | undefined): CapsFrame {
  if (requestId === undefined) return frame;
  return new CapsFrame(
    frame.anchorRef,
    frame.count,
    frame.data,
    frame.nextCursor,
    frame.tokenEst,
    frame.cached,
    frame.tokenizerUsed,
    requestId,
  );
}

function estimateTokens(rows: readonly unknown[]): number {
  return Math.max(1, Math.floor(JSON.stringify(rows).length / 4));
}

function encodingPolicyError(
  header: FrameHeader,
  defaultTier: EncodingTier,
  enabledEncodings: readonly string[],
): ErrorFrame | undefined {
  if (header.encodingTier === defaultTier) return undefined;
  if (
    header.encodingTier === EncodingTier.BINARY_VECTOR &&
    enabledEncodings.includes("binary_vector.v1") &&
    header.frameType === FrameType.QUERY
  ) {
    return undefined;
  }
  return new ErrorFrame(
    "NPS-SERVER-ENCODING-UNSUPPORTED",
    "NCP-ENCODING-UNSUPPORTED",
    `Frame type 0x${header.frameType.toString(16)} used ${encodingToken(header.encodingTier)}, ` +
      `but the negotiated policy allows ${enabledEncodings.join(", ")}.`,
  );
}

function encodingToken(tier: EncodingTier): string {
  switch (tier) {
    case EncodingTier.JSON: return "json";
    case EncodingTier.MSGPACK: return "msgpack";
    case EncodingTier.BINARY_VECTOR: return "binary_vector.v1";
    default: return `unknown:${tier as number}`;
  }
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function owned(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export { FrameType };
