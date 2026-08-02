// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { EncodingTier, FrameType } from "../core/frames.js";
import type { NpsFrame } from "../core/codec.js";

// ── FrameSchema ───────────────────────────────────────────────────────────────

export interface SchemaField {
  name:      string;
  type:      string;
  semantic?: string;
  nullable?: boolean;
}

export interface FrameSchema {
  fields: readonly SchemaField[];
}

// ── AnchorFrame ───────────────────────────────────────────────────────────────

export class AnchorFrame implements NpsFrame {
  readonly frameType     = FrameType.ANCHOR;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly anchorId: string,
    public readonly schema:   FrameSchema,
    public readonly ttl:      number = 3600,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      anchor_id: this.anchorId,
      schema:    { fields: this.schema.fields.map((f) => ({ ...f })) },
      ttl:       this.ttl,
    };
  }

  static fromDict(data: Record<string, unknown>): AnchorFrame {
    const schemaRaw = data["schema"] as { fields: SchemaField[] };
    return new AnchorFrame(
      data["anchor_id"] as string,
      { fields: schemaRaw.fields },
      (data["ttl"] as number | undefined) ?? 3600,
    );
  }
}

// ── JsonPatchOperation ────────────────────────────────────────────────────────

export interface JsonPatchOperation {
  op:     string;
  path:   string;
  value?: unknown;
}

// ── DiffFrame ─────────────────────────────────────────────────────────────────

export class DiffFrame implements NpsFrame {
  readonly frameType     = FrameType.DIFF;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly anchorRef: string,
    public readonly baseSeq:   number,
    public readonly patch:     readonly JsonPatchOperation[],
    public readonly entityId?: string,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      anchor_ref: this.anchorRef,
      base_seq:   this.baseSeq,
      patch:      this.patch.map((p) => ({ ...p })),
      entity_id:  this.entityId ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): DiffFrame {
    return new DiffFrame(
      data["anchor_ref"] as string,
      data["base_seq"]   as number,
      data["patch"]      as JsonPatchOperation[],
      (data["entity_id"] as string | null) ?? undefined,
    );
  }
}

// ── StreamFrame ───────────────────────────────────────────────────────────────

export class StreamFrame implements NpsFrame {
  readonly frameType     = FrameType.STREAM;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly streamId:   string,
    public readonly seq:        number,
    public readonly isLast:     boolean,
    public readonly data:       readonly Record<string, unknown>[],
    public readonly anchorRef?: string,
    public readonly windowSize?: number,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      stream_id:   this.streamId,
      seq:         this.seq,
      is_last:     this.isLast,
      data:        this.data,
      anchor_ref:  this.anchorRef  ?? null,
      window_size: this.windowSize ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): StreamFrame {
    return new StreamFrame(
      data["stream_id"]   as string,
      data["seq"]         as number,
      data["is_last"]     as boolean,
      data["data"]        as Record<string, unknown>[],
      (data["anchor_ref"]  as string | null)  ?? undefined,
      (data["window_size"] as number | null)  ?? undefined,
    );
  }
}

// ── CapsFrame ─────────────────────────────────────────────────────────────────

export class CapsFrame implements NpsFrame {
  readonly frameType     = FrameType.CAPS;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly anchorRef:      string,
    public readonly count:          number,
    public readonly data:           readonly Record<string, unknown>[],
    public readonly nextCursor?:    string,
    public readonly tokenEst?:      number,
    public readonly cached?:        boolean,
    public readonly tokenizerUsed?: string,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      anchor_ref:      this.anchorRef,
      count:           this.count,
      data:            this.data,
      next_cursor:     this.nextCursor    ?? null,
      token_est:       this.tokenEst      ?? null,
      cached:          this.cached        ?? null,
      tokenizer_used:  this.tokenizerUsed ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): CapsFrame {
    return new CapsFrame(
      data["anchor_ref"]     as string,
      data["count"]          as number,
      data["data"]           as Record<string, unknown>[],
      (data["next_cursor"]    as string | null) ?? undefined,
      (data["token_est"]      as number | null) ?? undefined,
      (data["cached"]         as boolean | null) ?? undefined,
      (data["tokenizer_used"] as string | null) ?? undefined,
    );
  }
}

// ── ErrorFrame ────────────────────────────────────────────────────────────────

export class ErrorFrame implements NpsFrame {
  readonly frameType     = FrameType.ERROR;
  readonly preferredTier = EncodingTier.MSGPACK;

  constructor(
    public readonly status:   string,
    public readonly error:    string,
    public readonly message?: string,
    public readonly details?: Record<string, unknown>,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      status:  this.status,
      error:   this.error,
      message: this.message ?? null,
      details: this.details ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): ErrorFrame {
    return new ErrorFrame(
      data["status"]  as string,
      data["error"]   as string,
      (data["message"] as string | null) ?? undefined,
      (data["details"] as Record<string, unknown> | null) ?? undefined,
    );
  }
}

// ── HelloFrame ────────────────────────────────────────────────────────────────
// NPS-1 §4.6 — Native-mode handshake (0x06). Always Tier-1 JSON: encoding
// is not yet negotiated when this frame is sent.

export class HelloFrame implements NpsFrame {
  readonly frameType     = FrameType.HELLO;
  readonly preferredTier = EncodingTier.JSON;

  static readonly DEFAULT_MAX_FRAME_PAYLOAD      = 0xFFFF;
  static readonly DEFAULT_MAX_CONCURRENT_STREAMS = 32;

  constructor(
    public readonly npsVersion:           string,
    public readonly supportedEncodings:   readonly string[],
    public readonly supportedProtocols:   readonly string[],
    public          minVersion?:          string,
    public          agentId?:             string,
    public          maxFramePayload:      number = HelloFrame.DEFAULT_MAX_FRAME_PAYLOAD,
    public          extSupport:           boolean = false,
    public          maxConcurrentStreams: number = HelloFrame.DEFAULT_MAX_CONCURRENT_STREAMS,
    public          e2eEncAlgorithms?:    readonly string[],
    public          pingIntervalMs:       number = 0,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      nps_version:            this.npsVersion,
      supported_encodings:    [...this.supportedEncodings],
      supported_protocols:    [...this.supportedProtocols],
      min_version:            this.minVersion ?? null,
      agent_id:               this.agentId    ?? null,
      max_frame_payload:      this.maxFramePayload,
      ext_support:            this.extSupport,
      max_concurrent_streams: this.maxConcurrentStreams,
      e2e_enc_algorithms:     this.e2eEncAlgorithms ? [...this.e2eEncAlgorithms] : null,
      ping_interval_ms:       this.pingIntervalMs,
    };
  }

  static fromDict(data: Record<string, unknown>): HelloFrame {
    return new HelloFrame(
      data["nps_version"]         as string,
      (data["supported_encodings"] as string[]) ?? [],
      (data["supported_protocols"] as string[]) ?? [],
      (data["min_version"]        as string | null) ?? undefined,
      (data["agent_id"]           as string | null) ?? undefined,
      (data["max_frame_payload"]  as number | null) ?? HelloFrame.DEFAULT_MAX_FRAME_PAYLOAD,
      (data["ext_support"]        as boolean | null) ?? false,
      (data["max_concurrent_streams"] as number | null) ?? HelloFrame.DEFAULT_MAX_CONCURRENT_STREAMS,
      (data["e2e_enc_algorithms"] as string[] | null) ?? undefined,
      (data["ping_interval_ms"]   as number | null) ?? 0,
    );
  }
}

// ── NcpHandshakeCapsFrame (0x04, native-mode handshake response) ───────────────
// NPS-1 §4.6 — Server's capability response to a HelloFrame in native mode.
// Uses frame type 0x04 (Caps) on the wire but carries the server NID and the
// negotiated encoding policy instead of a query result set.

export class NcpHandshakeCapsFrame implements NpsFrame {
  readonly frameType     = FrameType.CAPS;
  readonly preferredTier = EncodingTier.JSON;

  constructor(
    public readonly nodeId:             string,
    public readonly caps:               readonly string[],
    public          negotiatedEncoding?: string,
    public          enabledEncodings?:   readonly string[],
    public readonly anchorRef?:         string,
    public readonly payload?:           unknown,
    public          sessionVersion?:     string,
    public          supportedProtocols?: readonly string[],
    public          maxFramePayload?:    number,
    public          extSupport?:         boolean,
    public          maxConcurrentStreams?: number,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      node_id:             this.nodeId,
      caps:                [...this.caps],
      negotiated_encoding: this.negotiatedEncoding ?? null,
      enabled_encodings:   this.enabledEncodings ? [...this.enabledEncodings] : null,
      session_version:      this.sessionVersion ?? null,
      supported_protocols:  this.supportedProtocols ? [...this.supportedProtocols] : null,
      max_frame_payload:    this.maxFramePayload ?? null,
      ext_support:          this.extSupport ?? null,
      max_concurrent_streams: this.maxConcurrentStreams ?? null,
      anchor_ref:          this.anchorRef ?? null,
      payload:             this.payload   ?? null,
    };
  }

  static fromDict(data: Record<string, unknown>): NcpHandshakeCapsFrame {
    return new NcpHandshakeCapsFrame(
      data["node_id"] as string,
      (data["caps"] as string[]) ?? [],
      (data["negotiated_encoding"] as string | null) ?? undefined,
      (data["enabled_encodings"]   as string[] | null) ?? undefined,
      (data["anchor_ref"]          as string | null) ?? undefined,
      (data["payload"]             as unknown) ?? undefined,
      (data["session_version"]     as string | null) ?? undefined,
      (data["supported_protocols"] as string[] | null) ?? undefined,
      (data["max_frame_payload"]   as number | null) ?? undefined,
      (data["ext_support"]         as boolean | null) ?? undefined,
      (data["max_concurrent_streams"] as number | null) ?? undefined,
    );
  }
}

// ── NopFrame (0x07) ───────────────────────────────────────────────────────────
// NCP v0.8 §4.8 / §7.5 — Keepalive/heartbeat frame, no payload.
// Either peer MAY send after handshake; receiver MUST accept and SHOULD reply.

export class NopFrame implements NpsFrame {
  readonly frameType     = FrameType.NOP;
  readonly preferredTier = EncodingTier.JSON;

  toDict(): Record<string, unknown> {
    return {};
  }

  static fromDict(_data: Record<string, unknown>): NopFrame {
    return new NopFrame();
  }
}
