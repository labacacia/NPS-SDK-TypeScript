// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal DER reader — just enough for the two NIP v0.12 Phase-3 walks:
 * `SEQUENCE OF UTF8String` attestation extensions and the RFC 6960 OCSPResponse
 * `nextUpdate` lookup. Not a general ASN.1 library; it deliberately supports only
 * single-byte tags and definite-length encodings, which is all DER produces here.
 */

/** Thrown on any malformed / truncated DER content. */
export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

// ── Universal tags used here ─────────────────────────────────────────────────
export const TAG_ENUMERATED       = 0x0a;
export const TAG_UTF8_STRING      = 0x0c;
export const TAG_OBJECT_ID        = 0x06;
export const TAG_OCTET_STRING     = 0x04;
export const TAG_SEQUENCE         = 0x30;
export const TAG_GENERALIZED_TIME = 0x18;
/** Context-specific, constructed, number 0 — i.e. `[0] EXPLICIT`. */
export const TAG_CONTEXT_0        = 0xa0;

/** True for any context-specific tag (class bits `10`). */
export function isContextSpecific(tag: number): boolean {
  return (tag & 0xc0) === 0x80;
}

/** One tag-length-value read out of a buffer. */
export interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte. */
  contentEnd: number;
  /** Offset one past the whole TLV — where the next TLV begins. */
  end: number;
}

/**
 * A cursor over one DER value's content, handing out the child TLVs in order.
 * Mirrors .NET's `AsnReader`: `hasData`, `peekTag`, `read*`.
 */
export class DerReader {
  private pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly limit = buf.length,
  ) {
    this.pos = start;
  }

  get hasData(): boolean {
    return this.pos < this.limit;
  }

  /** Tag of the next TLV without consuming it. Throws when there is no more data. */
  peekTag(): number {
    if (!this.hasData) throw new DerError("unexpected end of DER data");
    return this.buf[this.pos]!;
  }

  /** Read the next TLV. When `expectedTag` is given, a mismatch throws. */
  read(expectedTag?: number): Tlv {
    const tlv = parseTlv(this.buf, this.pos, this.limit);
    if (expectedTag !== undefined && tlv.tag !== expectedTag) {
      throw new DerError(
        `expected DER tag 0x${expectedTag.toString(16)}, got 0x${tlv.tag.toString(16)}`,
      );
    }
    this.pos = tlv.end;
    return tlv;
  }

  /** Read the next TLV and return a reader over its *content* (for constructed values). */
  readSequence(expectedTag: number = TAG_SEQUENCE): DerReader {
    const tlv = this.read(expectedTag);
    return new DerReader(this.buf, tlv.contentStart, tlv.contentEnd);
  }

  /** Consume and discard the next TLV, whatever it is. */
  skip(): void {
    this.read();
  }

  /** Raw content bytes of the next TLV. */
  readContent(expectedTag?: number): Uint8Array {
    const tlv = this.read(expectedTag);
    return this.buf.subarray(tlv.contentStart, tlv.contentEnd);
  }

  /** Read a UTF8String's value. */
  readUtf8String(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.readContent(TAG_UTF8_STRING));
  }

  /** Read a GeneralizedTime as a `Date`. */
  readGeneralizedTime(): Date {
    return parseGeneralizedTime(
      new TextDecoder().decode(this.readContent(TAG_GENERALIZED_TIME)),
    );
  }
}

function parseTlv(buf: Uint8Array, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new DerError("truncated DER header");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte DER tags are not supported");

  let p = offset + 1;
  const first = buf[p]!;
  p += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const n = first & 0x7f;
    if (n === 0) throw new DerError("indefinite-length encoding is not valid DER");
    if (n > 4) throw new DerError("DER length exceeds the supported range");
    if (p + n > limit) throw new DerError("truncated DER length");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[p + i]!;
    p += n;
  }
  const contentEnd = p + length;
  if (contentEnd > limit) throw new DerError("DER value overruns its container");
  return { tag, contentStart: p, contentEnd, end: contentEnd };
}

/**
 * Parse an ASN.1 GeneralizedTime. DER requires the UTC form `YYYYMMDDHHMMSSZ`;
 * an optional fractional-second part is tolerated.
 */
export function parseGeneralizedTime(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(value);
  if (!m) throw new DerError(`malformed GeneralizedTime: '${value}'`);
  const ms = m[7] ? Math.round(Number.parseFloat(m[7]) * 1000) : 0;
  const t = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), ms,
  );
  if (Number.isNaN(t)) throw new DerError(`malformed GeneralizedTime: '${value}'`);
  return new Date(t);
}

/** Encode a DER TLV — used only by tests and by the CA-side extension builder. */
export function derEncode(tag: number, content: Uint8Array): Uint8Array {
  let header: number[];
  if (content.length < 0x80) {
    header = [tag, content.length];
  } else {
    const lenBytes: number[] = [];
    let n = content.length;
    while (n > 0) { lenBytes.unshift(n & 0xff); n >>>= 8; }
    header = [tag, 0x80 | lenBytes.length, ...lenBytes];
  }
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

/** DER-encode a `SEQUENCE OF UTF8String` — the shape of the id-nps-* attestation extensions. */
export function derEncodeUtf8Sequence(values: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = values.map((v) => derEncode(TAG_UTF8_STRING, enc.encode(v)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const content = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { content.set(p, o); o += p.length; }
  return derEncode(TAG_SEQUENCE, content);
}
