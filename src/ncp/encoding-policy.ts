// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Encoding policy negotiated for an established NCP native-mode session
 * (NPS-1 §4.6). The default tier is stable for ordinary frames; Tier-3
 * BinaryVector is an optional extension for frame classes that explicitly
 * bind to it (currently only QueryFrame).
 *
 * Ported from NPS-sdk-dotnet/src/NPS.Core/Ncp/NcpEncodingPolicy.cs.
 */

import { EncodingTier, FrameType } from "../core/frames.js";
import type { FrameHeader } from "../core/frames.js";
import { NpsError } from "../core/exceptions.js";

/** Thrown when a frame uses an encoding the negotiated session policy forbids. */
export class NpsEncodingUnsupportedError extends NpsError {
  readonly errorCode = "NCP-ENCODING-UNSUPPORTED";
  readonly statusCode = "NPS-SERVER-ENCODING-UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "NpsEncodingUnsupportedError";
  }
}

export class NcpEncodingPolicy {
  constructor(
    public readonly defaultTier: EncodingTier,
    public readonly binaryVectorEnabled: boolean = false,
  ) {}

  /** Encodings enabled by this policy, default tier first. */
  get enabledEncodings(): string[] {
    return this.binaryVectorEnabled
      ? [NcpEncodingPolicy.encodingToken(this.defaultTier), "binary_vector.v1"]
      : [NcpEncodingPolicy.encodingToken(this.defaultTier)];
  }

  /** Returns true if a frame of `frameType` may be sent with `tier`. */
  allows(tier: EncodingTier, frameType: FrameType): boolean {
    return (
      tier === this.defaultTier ||
      (tier === EncodingTier.BINARY_VECTOR &&
        this.binaryVectorEnabled &&
        NcpEncodingPolicy.isBinaryVectorFrame(frameType))
    );
  }

  /**
   * Throws {@link NpsEncodingUnsupportedError} if `header` uses an encoding the
   * negotiated session policy does not allow.
   */
  ensureAllows(header: FrameHeader): void {
    if (this.allows(header.encodingTier, header.frameType)) return;

    throw new NpsEncodingUnsupportedError(
      `Frame type 0x${header.frameType.toString(16).padStart(2, "0")} used ` +
        `${NcpEncodingPolicy.encodingToken(header.encodingTier)}, but the negotiated ` +
        `session policy allows ${this.enabledEncodings.join(", ")}.`,
    );
  }

  /** Builds a policy from a server's advertised `enabled_encodings` list. */
  static fromEnabledEncodings(
    defaultTier: EncodingTier,
    enabledEncodings: readonly string[] | undefined | null,
  ): NcpEncodingPolicy {
    return new NcpEncodingPolicy(
      defaultTier,
      enabledEncodings?.includes("binary_vector.v1") === true,
    );
  }

  /** Wire token for an encoding tier. */
  static encodingToken(tier: EncodingTier): string {
    switch (tier) {
      case EncodingTier.JSON:
        return "json";
      case EncodingTier.MSGPACK:
        return "msgpack";
      case EncodingTier.BINARY_VECTOR:
        return "binary_vector.v1";
      default:
        return `unknown:${tier as number}`;
    }
  }

  private static isBinaryVectorFrame(frameType: FrameType): boolean {
    return frameType === FrameType.QUERY;
  }
}
