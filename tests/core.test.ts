// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEADER_SIZE,
  EXTENDED_HEADER_SIZE,
  FrameFlags,
  FrameHeader,
  FrameType,
  EncodingTier,
  NpsCodecError,
  NpsFrameError,
  NpsAnchorNotFoundError,
  NpsAnchorPoisonError,
  NpsFrameCodec,
  Tier1JsonCodec,
  Tier2MsgPackCodec,
  FrameRegistry,
  AnchorFrameCache,
} from "../src/core/index.js";
import { AnchorFrame, CapsFrame, DiffFrame, ErrorFrame, StreamFrame } from "../src/ncp/frames.js";
import { registerNcpFrames } from "../src/ncp/registry.js";
import { createDefaultRegistry, createFullRegistry } from "../src/setup.js";

// ── FrameHeader ───────────────────────────────────────────────────────────────

describe("FrameHeader", () => {
  it("parses a default (4-byte) header", () => {
    const buf = new Uint8Array([0x01, 0x05, 0x00, 0x0A]); // ANCHOR, FINAL|JSON, length=10
    const h   = FrameHeader.parse(buf);
    expect(h.frameType).toBe(FrameType.ANCHOR);
    expect(h.isFinal).toBe(true);
    expect(h.payloadLength).toBe(10);
    expect(h.isExtended).toBe(false);
    expect(h.headerSize).toBe(DEFAULT_HEADER_SIZE);
  });

  it("parses an extended (8-byte) header", () => {
    const buf  = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint8(0, FrameType.CAPS);
    view.setUint8(1, FrameFlags.EXT | FrameFlags.TIER2_MSGPACK | FrameFlags.FINAL);
    view.setUint16(2, 0, false);         // reserved
    view.setUint32(4, 100_000, false);   // payload length
    const h = FrameHeader.parse(buf);
    expect(h.isExtended).toBe(true);
    expect(h.headerSize).toBe(EXTENDED_HEADER_SIZE);
    expect(h.payloadLength).toBe(100_000);
  });

  it("round-trips default header via toBytes()", () => {
    const h    = new FrameHeader(FrameType.ANCHOR, FrameFlags.FINAL | FrameFlags.TIER2_MSGPACK, 42);
    const back = FrameHeader.parse(h.toBytes());
    expect(back.frameType).toBe(FrameType.ANCHOR);
    expect(back.payloadLength).toBe(42);
  });

  it("round-trips extended header via toBytes()", () => {
    const h    = new FrameHeader(FrameType.CAPS, FrameFlags.EXT | FrameFlags.FINAL | FrameFlags.TIER1_JSON, 70_000);
    const back = FrameHeader.parse(h.toBytes());
    expect(back.isExtended).toBe(true);
    expect(back.payloadLength).toBe(70_000);
  });

  it("throws NpsFrameError for buffer too small", () => {
    expect(() => FrameHeader.parse(new Uint8Array([0x01]))).toThrow(NpsFrameError);
  });

  it("throws NpsFrameError for extended header with short buffer", () => {
    const buf = new Uint8Array([0x01, FrameFlags.EXT, 0x00, 0x00]); // EXT but only 4 bytes
    expect(() => FrameHeader.parse(buf)).toThrow(NpsFrameError);
  });

  it("exposes encoding tier", () => {
    const h = new FrameHeader(FrameType.ANCHOR, FrameFlags.TIER2_MSGPACK | FrameFlags.FINAL, 0);
    expect(h.encodingTier).toBe(EncodingTier.MSGPACK);
  });
});

// ── Exceptions ────────────────────────────────────────────────────────────────

describe("Exceptions", () => {
  it("NpsAnchorNotFoundError carries anchorId", () => {
    const err = new NpsAnchorNotFoundError("sha256:abc");
    expect(err.anchorId).toBe("sha256:abc");
    expect(err).toBeInstanceOf(NpsAnchorNotFoundError);
  });

  it("NpsAnchorPoisonError carries anchorId", () => {
    const err = new NpsAnchorPoisonError("sha256:abc");
    expect(err.anchorId).toBe("sha256:abc");
  });
});

// ── FrameRegistry ─────────────────────────────────────────────────────────────

describe("FrameRegistry", () => {
  it("resolves a registered frame class", () => {
    const r = createDefaultRegistry();
    const cls = r.resolve(FrameType.ANCHOR);
    expect(cls).toBe(AnchorFrame);
  });

  it("throws NpsFrameError for unknown frame type", () => {
    const r = new FrameRegistry();
    expect(() => r.resolve(FrameType.ANCHOR)).toThrow(NpsFrameError);
  });

  it("createFullRegistry registers all 5 protocols", () => {
    const r = createFullRegistry();
    for (const ft of [
      FrameType.ANCHOR, FrameType.QUERY, FrameType.IDENT,
      FrameType.ANNOUNCE, FrameType.TASK,
    ]) {
      expect(() => r.resolve(ft)).not.toThrow();
    }
  });
});

// ── AnchorFrameCache ──────────────────────────────────────────────────────────

describe("AnchorFrameCache", () => {
  const makeSchema = (fields = [{ name: "id", type: "uint64" }]) => ({ fields });

  it("computeAnchorId is deterministic", () => {
    const s = makeSchema();
    expect(AnchorFrameCache.computeAnchorId(s)).toBe(AnchorFrameCache.computeAnchorId(s));
    expect(AnchorFrameCache.computeAnchorId(s)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computeAnchorId is field-order independent", () => {
    const s1 = { fields: [{ name: "a", type: "string" }, { name: "b", type: "uint64" }] };
    const s2 = { fields: [{ name: "b", type: "uint64" }, { name: "a", type: "string" }] };
    expect(AnchorFrameCache.computeAnchorId(s1)).toBe(AnchorFrameCache.computeAnchorId(s2));
  });

  it("set + get roundtrip", () => {
    const cache  = new AnchorFrameCache();
    const schema = makeSchema();
    const aid    = AnchorFrameCache.computeAnchorId(schema);
    const frame  = new AnchorFrame(aid, schema, 3600);
    cache.set(frame);
    expect(cache.get(aid)).toBe(frame);
  });

  it("getRequired returns frame when present", () => {
    const cache  = new AnchorFrameCache();
    const schema = makeSchema();
    const aid    = AnchorFrameCache.computeAnchorId(schema);
    const frame  = new AnchorFrame(aid, schema, 3600);
    cache.set(frame);
    expect(cache.getRequired(aid)).toBe(frame);
  });

  it("getRequired throws when missing", () => {
    const cache = new AnchorFrameCache();
    expect(() => cache.getRequired("sha256:" + "0".repeat(64))).toThrow(NpsAnchorNotFoundError);
  });

  it("get returns undefined after TTL expiry", () => {
    const cache  = new AnchorFrameCache();
    let   now    = 0;
    cache.clock  = () => now;
    const schema = makeSchema();
    const aid    = AnchorFrameCache.computeAnchorId(schema);
    cache.set(new AnchorFrame(aid, schema, 10));
    now = 11_000;  // 11 seconds later
    expect(cache.get(aid)).toBeUndefined();
  });

  it("idempotent set with same schema", () => {
    const cache  = new AnchorFrameCache();
    const schema = makeSchema();
    const aid    = AnchorFrameCache.computeAnchorId(schema);
    const frame  = new AnchorFrame(aid, schema, 3600);
    cache.set(frame);
    cache.set(frame);
    expect(cache.size).toBe(1);
  });

  it("poison detection raises NpsAnchorPoisonError", () => {
    const cache   = new AnchorFrameCache();
    const schemaA = makeSchema([{ name: "id", type: "uint64" }]);
    const schemaB = makeSchema([{ name: "price", type: "decimal" }]);
    const aid     = AnchorFrameCache.computeAnchorId(schemaA);
    cache.set(new AnchorFrame(aid, schemaA, 3600));
    expect(() => cache.set(new AnchorFrame(aid, schemaB, 3600))).toThrow(NpsAnchorPoisonError);
  });

  it("invalidate removes entry", () => {
    const cache  = new AnchorFrameCache();
    const schema = makeSchema();
    const aid    = AnchorFrameCache.computeAnchorId(schema);
    cache.set(new AnchorFrame(aid, schema, 3600));
    cache.invalidate(aid);
    expect(cache.get(aid)).toBeUndefined();
  });

  it("size evicts expired entries", () => {
    const cache  = new AnchorFrameCache();
    let   now    = 0;
    cache.clock  = () => now;
    const s1 = makeSchema([{ name: "id", type: "uint64" }]);
    const s2 = makeSchema([{ name: "x",  type: "string"  }]);
    cache.set(new AnchorFrame(AnchorFrameCache.computeAnchorId(s1), s1, 100));
    cache.set(new AnchorFrame(AnchorFrameCache.computeAnchorId(s2), s2, 1));
    now = 2_000; // s2 expired
    expect(cache.size).toBe(1);
  });
});

// ── NpsFrameCodec ─────────────────────────────────────────────────────────────

describe("NpsFrameCodec — NCP round-trips", () => {
  const registry = createDefaultRegistry();
  const codec    = new NpsFrameCodec(registry);
  const aid      = "sha256:" + "a".repeat(64);
  const schema   = { fields: [{ name: "id", type: "uint64" }, { name: "name", type: "string" }] };

  it("encodes/decodes AnchorFrame (MsgPack)", () => {
    const frame = new AnchorFrame(aid, schema, 3600);
    const out   = codec.decode(codec.encode(frame)) as AnchorFrame;
    expect(out).toBeInstanceOf(AnchorFrame);
    expect(out.anchorId).toBe(aid);
    expect(out.ttl).toBe(3600);
  });

  it("encodes/decodes AnchorFrame (JSON override)", () => {
    const frame = new AnchorFrame(aid, schema, 7200);
    const wire  = codec.encode(frame, { overrideTier: EncodingTier.JSON });
    const out   = codec.decode(wire) as AnchorFrame;
    expect(out.ttl).toBe(7200);
  });

  it("encodes/decodes DiffFrame", () => {
    const frame = new DiffFrame(aid, 3, [{ op: "replace", path: "/name", value: "Bob" }], "ent:1");
    const out   = codec.decode(codec.encode(frame)) as DiffFrame;
    expect(out).toBeInstanceOf(DiffFrame);
    expect(out.baseSeq).toBe(3);
    expect(out.patch[0]?.op).toBe("replace");
    expect(out.entityId).toBe("ent:1");
  });

  it("encodes/decodes StreamFrame — non-final clears FINAL flag", () => {
    const frame = new StreamFrame("s-1", 0, false, [{ id: 1 }]);
    const wire  = codec.encode(frame);
    expect(NpsFrameCodec.peekHeader(wire).isFinal).toBe(false);
    const out = codec.decode(wire) as StreamFrame;
    expect(out.isLast).toBe(false);
  });

  it("encodes/decodes StreamFrame — final sets FINAL flag", () => {
    const frame = new StreamFrame("s-1", 1, true, [{ id: 2 }], aid, 10);
    const wire  = codec.encode(frame);
    expect(NpsFrameCodec.peekHeader(wire).isFinal).toBe(true);
    const out = codec.decode(wire) as StreamFrame;
    expect(out.isLast).toBe(true);
    expect(out.windowSize).toBe(10);
  });

  it("encodes/decodes CapsFrame", () => {
    const frame = new CapsFrame(aid, 2, [{ id: 1 }, { id: 2 }], "cursor:X", 100, true, "cl100k", "req-caps-1");
    const out   = codec.decode(codec.encode(frame)) as CapsFrame;
    expect(out).toBeInstanceOf(CapsFrame);
    expect(out.count).toBe(2);
    expect(out.nextCursor).toBe("cursor:X");
    expect(out.tokenizerUsed).toBe("cl100k");
    expect(out.requestId).toBe("req-caps-1");
  });

  it("encodes/decodes ErrorFrame", () => {
    const frame = new ErrorFrame("NPS-SERVER-INTERNAL", "NCP-ANCHOR-NOT-FOUND", "missing anchor", { ref: aid });
    const out   = codec.decode(codec.encode(frame)) as ErrorFrame;
    expect(out).toBeInstanceOf(ErrorFrame);
    expect(out.status).toBe("NPS-SERVER-INTERNAL");
    expect(out.message).toBe("missing anchor");
  });

  it("peekHeader decodes only the header", () => {
    const frame  = new AnchorFrame(aid, schema);
    const wire   = codec.encode(frame);
    const header = NpsFrameCodec.peekHeader(wire);
    expect(header.frameType).toBe(FrameType.ANCHOR);
  });

  it("throws NpsCodecError for unsupported tier", () => {
    // @ts-expect-error intentional bad value
    expect(() => codec["_selectCodec"](0x03)).toThrow(NpsCodecError);
  });

  it("throws NpsCodecError when payload exceeds maxPayload", () => {
    const tiny  = new NpsFrameCodec(registry, { maxPayload: 5 });
    const frame = new AnchorFrame(aid, schema);
    expect(() => tiny.encode(frame)).toThrow(NpsCodecError);
  });

  it("sets EXT flag when payload > 64 KiB", () => {
    const large  = new NpsFrameCodec(registry, { maxPayload: 200_000 });
    const bigData = Array.from({ length: 400 }, (_, i) => ({ id: i, name: "x".repeat(200) }));
    const frame   = new CapsFrame(aid, bigData.length, bigData);
    const wire    = large.encode(frame, { overrideTier: EncodingTier.JSON });
    expect(NpsFrameCodec.peekHeader(wire).isExtended).toBe(true);
  });

  it("Tier-1 JSON encode error wraps as NpsCodecError", () => {
    const j = new Tier1JsonCodec();
    const bad = { frameType: FrameType.ANCHOR, preferredTier: EncodingTier.JSON, toDict: () => ({ v: BigInt(1) }) };
    // @ts-expect-error intentional bad frame
    expect(() => j.encode(bad)).toThrow(NpsCodecError);
  });

  it("Tier-1 JSON decode error wraps as NpsCodecError", () => {
    const j = new Tier1JsonCodec();
    expect(() => j.decode(FrameType.ANCHOR, new Uint8Array([0xff, 0xfe]), registry)).toThrow(NpsCodecError);
  });

  it("Tier-2 MsgPack decode error wraps as NpsCodecError", () => {
    const m = new Tier2MsgPackCodec();
    // \xc1 is always-invalid in MsgPack
    expect(() => m.decode(FrameType.ANCHOR, new Uint8Array([0xc1, 0xff, 0x00]), registry)).toThrow(NpsCodecError);
  });

  it("throws NpsFrameError for unknown frame type", () => {
    const wire = new Uint8Array([0x99, FrameFlags.FINAL | FrameFlags.TIER1_JSON, 0x00, 0x02, 0x7b, 0x7d]);
    expect(() => codec.decode(wire)).toThrow();
  });
});
