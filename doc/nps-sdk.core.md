English | [中文版](./nps-sdk.core.cn.md)

# `@labacacia/nps-sdk/core` — Class and Method Reference

> Spec: [NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.md)

Wire-level primitives: frame header parsing, the codec pair
(Tier-1 JSON / Tier-2 MsgPack), the anchor cache, error types, and
canonical-JSON helpers used by NIP signing.

---

## Table of contents

- [Frame types & constants](#frame-types--constants)
- [`FrameHeader`](#frameheader)
- [`NpsFrameCodec`](#npsframecodec)
- [Functional codec API](#functional-codec-api)
- [`FrameRegistry`](#frameregistry)
- [`AnchorCache`](#anchorcache)
- [Canonical JSON](#canonical-json)
- [Exceptions](#exceptions)
- [Status codes](#status-codes)
- [`CryptoProvider`](#cryptoprovider)

---

## Frame types & constants

```typescript
export enum FrameType {
  // NCP
  Anchor    = 0x01,   Diff     = 0x02,   Stream = 0x03,
  Caps      = 0x04,   Align    = 0x05,   Hello  = 0x06,
  // NWP
  Query     = 0x10,   Action   = 0x11,   Subscribe = 0x12,
  // NIP
  Ident     = 0x20,   Trust    = 0x21,   Revoke    = 0x22,
  // NDP
  Announce  = 0x30,   Resolve  = 0x31,   Graph     = 0x32,
  // NOP
  Task      = 0x40,   Delegate = 0x41,   Sync      = 0x42,
  AlignStream = 0x43,
  // System
  Error     = 0xFE,
}

export enum EncodingTier {
  JSON    = 0x00,
  MSGPACK = 0x01,
}

export const FrameFlags = {
  NONE:          0x00,
  TIER1_JSON:    0x00,
  TIER2_MSGPACK: 0x01,
  FINAL:         0x04,
  ENCRYPTED:     0x08,
  EXT:           0x80,
} as const;

export const DEFAULT_HEADER_SIZE  = 4;           // bytes
export const EXTENDED_HEADER_SIZE = 8;
export const DEFAULT_MAX_PAYLOAD  = 0xFFFF;      // 64 KiB − 1
export const EXTENDED_MAX_PAYLOAD = 0xFFFF_FFFF; // 4 GiB − 1
```

`Align (0x05)` is deprecated — use `AlignStream (0x43)` from NOP instead.

---

## `FrameHeader`

Parsed + serialisable wire header (NPS-1 §3.1).

```typescript
class FrameHeader {
  constructor(
    public readonly frameType: FrameType,
    public readonly flags: number,
    public readonly payloadLength: number,
  );

  readonly isExtended:   boolean;       // EXT bit
  readonly headerSize:   number;        // 4 or 8
  readonly encodingTier: EncodingTier;  // lower 2 bits
  readonly isFinal:      boolean;       // bit 2
  readonly isEncrypted:  boolean;       // bit 3

  static parse(buf: Uint8Array): FrameHeader;
  toBytes(): Uint8Array;
}
```

Default header: `[type][flags][len_be_u16]` (4 bytes).
Extended header (`EXT=1`): `[type][flags][0 0][len_be_u32]` (8 bytes).

---

## `NpsFrameCodec`

Top-level codec dispatching between Tier-1 JSON and Tier-2 MsgPack based on
the flags byte.

```typescript
interface NpsFrame {
  readonly frameType:     FrameType;
  readonly preferredTier: EncodingTier;
  toDict(): Record<string, unknown>;
}

class NpsFrameCodec {
  constructor(
    registry: FrameRegistry,
    options?: { maxPayload?: number },
  );

  encode(frame: NpsFrame, options?: { overrideTier?: EncodingTier }): Uint8Array;
  decode(wire: Uint8Array): NpsFrame;

  static peekHeader(wire: Uint8Array): FrameHeader;
}
```

### `encode(frame, opts?)`

Serialises the frame's `toDict()` via the chosen tier and prepends the
header. Automatically sets `EXT=1` if the payload exceeds
`DEFAULT_MAX_PAYLOAD`. For `StreamFrame`, `FINAL` flag is set when
`isLast === true`; for every other frame it is always set.

Raises `NpsCodecError` when:
- encoding fails,
- the encoded payload exceeds `maxPayload` (default 65 535).

### `decode(wire)`

Parses the header, slices the payload, resolves the frame class from the
registry, and calls `fromDict(data)`.

### `peekHeader(wire)` *(static)*

Returns the parsed header without decoding the payload — useful for
routing, sizing, or dumping.

---

## Functional codec API

Re-exported from `@labacacia/nps-sdk/core`. Thin, allocation-light pair
used by tests and tools that don't want a class instance.

```typescript
// Tier-level helpers
function encodeJson(payload: unknown): Uint8Array;
function decodeJson(bytes: Uint8Array): unknown;

function encodeMsgPack(payload: unknown): Uint8Array;
function decodeMsgPack(bytes: Uint8Array): unknown;

// Full frame helpers
function encodeFrame(
  payload: unknown,
  options: {
    frameType: number;
    tier?: EncodingTier;
    final?: boolean;
    encrypted?: boolean;
    extended?: boolean;
  },
): Uint8Array;

function decodeFrame(
  buffer: Uint8Array,
  options?: { maxFramePayload?: number },
): {
  header:        FrameHeader;   // the interface shape from frame-header.ts
  payload:       unknown;
  bytesConsumed: number;
};

// Low-level header I/O
function parseFrameHeader(buffer: Uint8Array, opts?: { max_frame_payload?: number }): FrameHeaderInterface;
function writeFrameHeader(header: FrameHeaderInterface, buffer: Uint8Array): number;
function buildFlags(options: {
  tier?: EncodingTier; final?: boolean; encrypted?: boolean; extended?: boolean;
}): number;
```

Errors are raised as `NcpError` with a protocol code (e.g.
`NCP-FRAME-FLAGS-INVALID`, `NCP-FRAME-PAYLOAD-TOO-LARGE`,
`NCP-FRAME-PARSE-ERROR`).

---

## `FrameRegistry`

Maps `FrameType` bytes to frame classes implementing `FrameClass.fromDict`.
Used by `NpsFrameCodec.decode` to materialise typed instances.

```typescript
class FrameRegistry {
  register(frameType: FrameType, cls: FrameClass): void;
  resolve(frameType: FrameType): FrameClass;  // throws NpsFrameError if unknown
}

interface FrameClass {
  fromDict(data: Record<string, unknown>): NpsFrame;
}
```

The root package exports two factories:

```typescript
import { createDefaultRegistry, createFullRegistry } from "@labacacia/nps-sdk";

createDefaultRegistry();   // NCP only — ANCHOR + DIFF + STREAM + CAPS + ERROR
createFullRegistry();      // NCP + NWP + NIP + NDP + NOP
```

Use `createFullRegistry()` when you need the codec to decode arbitrary
frames; the clients construct a suitable registry internally.

---

## `AnchorCache`

Bounded, TTL-aware schema cache (NPS-1 §5.3, §7.2, §9).

```typescript
class AnchorCache {
  constructor(options?: { maxSize?: number; getNow?: () => number });

  set(frame: AnchorFrame): void;
  get(anchorId: string): AnchorFrame | null;
  getRequired(anchorId: string): AnchorFrame;  // throws NcpError NCP-ANCHOR-NOT-FOUND
  readonly size: number;
}
```

### Behaviour

- `ttl === 0` → frame is NOT cached (spec §4.1, "session-only").
- Re-setting an anchor with a **different** schema throws
  `NcpError("NCP-ANCHOR-ID-MISMATCH")` — poisoning detection (§7.2).
- When the cache is full, the least-recently-accessed entry is evicted.
- Expiry is evaluated on every `get()`; no background timer.
- Override `getNow` for deterministic tests.

---

## Canonical JSON

Two distinct JSON normalisations ship with the SDK:

```typescript
function jcsStringify(obj: unknown): string;     // RFC 8785 (JCS)
function sortKeysStringify(obj: unknown): string; // sort keys, compact separators
```

- `jcsStringify` is the canonical form used for `AnchorFrame.anchor_id`
  hashing (SHA-256 over the JCS bytes).
- `sortKeysStringify` mirrors Python's `json.dumps(sort_keys=True, separators=(",", ":"))`
  and is used by NIP signing for cross-language parity.

---

## Exceptions

```typescript
class NpsError           extends Error {}
class NpsFrameError      extends NpsError {}
class NpsCodecError      extends NpsError {}
class NpsAnchorNotFoundError extends NpsError { readonly anchorId: string; }
class NpsAnchorPoisonError   extends NpsError { readonly anchorId: string; }
class NpsStreamError     extends NpsError {}

class NcpError extends Error { readonly code: string; }
```

`NcpError` carries a spec error code (e.g. `NCP-STREAM-SEQ-GAP`). It is
thrown by the functional codec, the stream manager, and the validators;
`NpsError` subclasses are thrown by the class-based codec and cache.

---

## Status codes

```typescript
import { NpsStatusCodes } from "@labacacia/nps-sdk/core";

NpsStatusCodes.NPS_OK;                     // "NPS-OK"
NpsStatusCodes.NPS_CLIENT_NOT_FOUND;       // "NPS-CLIENT-NOT-FOUND"
NpsStatusCodes.NPS_STREAM_SEQ_GAP;         // "NPS-STREAM-SEQ-GAP"
// …
```

Constant bundle matching `spec/status-codes.md`. Use these whenever you
need to emit an `ErrorFrame` or compare against the `status` field.

---

## `CryptoProvider`

Structural scaffold for pluggable async crypto (Node `node:crypto` vs
browser `SubtleCrypto`). Not instantiated by the public API today; NIP
currently uses `@noble/ed25519` directly. Exported for downstream
implementers.

```typescript
interface CryptoProvider {
  randomBytes(n: number): Uint8Array;

  ed25519GenerateKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  ed25519Sign(privateKey: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  ed25519Verify(publicKey: Uint8Array, data: Uint8Array, sig: Uint8Array): Promise<boolean>;

  aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertextAndTag: Uint8Array): Promise<Uint8Array>;

  pbkdf2Sha256(
    passphrase: Uint8Array, salt: Uint8Array,
    iterations: number, keyLen: number,
  ): Promise<Uint8Array>;
}
```
