[English Version](./nps-sdk.core.md) | 中文版

# `@labacacia/nps-sdk/core` — 类与方法参考

> 规范：[NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.md)

线路层原语：帧头解析、编解码器对（Tier-1 JSON / Tier-2 MsgPack）、
锚点缓存、错误类型，以及 NIP 签名使用的规范化 JSON 辅助函数。

---

## 目录

- [帧类型与常量](#帧类型与常量)
- [`FrameHeader`](#frameheader)
- [`NpsFrameCodec`](#npsframecodec)
- [函数式编解码 API](#函数式编解码-api)
- [`FrameRegistry`](#frameregistry)
- [`AnchorCache`](#anchorcache)
- [规范化 JSON](#规范化-json)
- [异常](#异常)
- [状态码](#状态码)
- [`CryptoProvider`](#cryptoprovider)

---

## 帧类型与常量

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

export const DEFAULT_HEADER_SIZE  = 4;           // 字节
export const EXTENDED_HEADER_SIZE = 8;
export const DEFAULT_MAX_PAYLOAD  = 0xFFFF;      // 64 KiB − 1
export const EXTENDED_MAX_PAYLOAD = 0xFFFF_FFFF; // 4 GiB − 1
```

`Align (0x05)` 已弃用 —— 请改用 NOP 的 `AlignStream (0x43)`。

---

## `FrameHeader`

可解析 + 可序列化的线路帧头（NPS-1 §3.1）。

```typescript
class FrameHeader {
  constructor(
    public readonly frameType: FrameType,
    public readonly flags: number,
    public readonly payloadLength: number,
  );

  readonly isExtended:   boolean;       // EXT 位
  readonly headerSize:   number;        // 4 或 8
  readonly encodingTier: EncodingTier;  // 低 2 位
  readonly isFinal:      boolean;       // 第 2 位
  readonly isEncrypted:  boolean;       // 第 3 位

  static parse(buf: Uint8Array): FrameHeader;
  toBytes(): Uint8Array;
}
```

默认帧头：`[type][flags][len_be_u16]`（4 字节）。
扩展帧头（`EXT=1`）：`[type][flags][0 0][len_be_u32]`（8 字节）。

---

## `NpsFrameCodec`

顶层编解码器，根据 flag 字节在 Tier-1 JSON 和 Tier-2 MsgPack 之间分派。

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

通过所选 tier 序列化帧的 `toDict()` 并前置帧头。当 payload
超过 `DEFAULT_MAX_PAYLOAD` 时自动设置 `EXT=1`。对 `StreamFrame`，
当 `isLast === true` 时设置 `FINAL` flag；其他每个帧都始终设置。

以下情况抛 `NpsCodecError`：
- 编码失败；
- 编码后 payload 超过 `maxPayload`（默认 65 535）。

### `decode(wire)`

解析帧头、切出 payload、从注册表解析帧类、调用 `fromDict(data)`。

### `peekHeader(wire)`（静态）

返回解析后的帧头而不解码 payload —— 对路由、计长或转储很有用。

---

## 函数式编解码 API

从 `@labacacia/nps-sdk/core` 重新导出。轻量、少分配的函数对，
被测试和不希望持有类实例的工具使用。

```typescript
// Tier 级辅助
function encodeJson(payload: unknown): Uint8Array;
function decodeJson(bytes: Uint8Array): unknown;

function encodeMsgPack(payload: unknown): Uint8Array;
function decodeMsgPack(bytes: Uint8Array): unknown;

// 完整帧辅助
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
  header:        FrameHeader;   // 来自 frame-header.ts 的接口形态
  payload:       unknown;
  bytesConsumed: number;
};

// 低层帧头 I/O
function parseFrameHeader(buffer: Uint8Array, opts?: { max_frame_payload?: number }): FrameHeaderInterface;
function writeFrameHeader(header: FrameHeaderInterface, buffer: Uint8Array): number;
function buildFlags(options: {
  tier?: EncodingTier; final?: boolean; encrypted?: boolean; extended?: boolean;
}): number;
```

错误以 `NcpError` 抛出，并带协议错误码（如
`NCP-FRAME-FLAGS-INVALID`、`NCP-FRAME-PAYLOAD-TOO-LARGE`、
`NCP-FRAME-PARSE-ERROR`）。

---

## `FrameRegistry`

将 `FrameType` 字节映射到实现 `FrameClass.fromDict` 的帧类。
`NpsFrameCodec.decode` 用它来实例化有类型的实例。

```typescript
class FrameRegistry {
  register(frameType: FrameType, cls: FrameClass): void;
  resolve(frameType: FrameType): FrameClass;  // 未知类型抛 NpsFrameError
}

interface FrameClass {
  fromDict(data: Record<string, unknown>): NpsFrame;
}
```

根包导出两个工厂：

```typescript
import { createDefaultRegistry, createFullRegistry } from "@labacacia/nps-sdk";

createDefaultRegistry();   // 仅 NCP —— ANCHOR + DIFF + STREAM + CAPS + ERROR
createFullRegistry();      // NCP + NWP + NIP + NDP + NOP
```

当需要编解码器解码任意帧时使用 `createFullRegistry()`；客户端
内部会构造合适的注册表。

---

## `AnchorCache`

有界、TTL 感知的 schema 缓存（NPS-1 §5.3、§7.2、§9）。

```typescript
class AnchorCache {
  constructor(options?: { maxSize?: number; getNow?: () => number });

  set(frame: AnchorFrame): void;
  get(anchorId: string): AnchorFrame | null;
  getRequired(anchorId: string): AnchorFrame;  // 抛 NcpError NCP-ANCHOR-NOT-FOUND
  readonly size: number;
}
```

### 行为

- `ttl === 0` → 帧**不**被缓存（规范 §4.1，"仅本 session"）。
- 用**不同** schema 重新 set 同一锚点会抛
  `NcpError("NCP-ANCHOR-ID-MISMATCH")` —— 投毒检测（§7.2）。
- 缓存满时，最近访问时间最早的条目被清除。
- 过期在每次 `get()` 时评估；没有后台定时器。
- 为可重现测试覆写 `getNow`。

---

## 规范化 JSON

SDK 提供两种不同的 JSON 规范化方案：

```typescript
function jcsStringify(obj: unknown): string;     // RFC 8785 (JCS)
function sortKeysStringify(obj: unknown): string; // 按键排序、紧凑分隔符
```

- `jcsStringify` 是 `AnchorFrame.anchor_id` 哈希所用的规范形式
  （对 JCS 字节做 SHA-256）。
- `sortKeysStringify` 镜像 Python 的
  `json.dumps(sort_keys=True, separators=(",", ":"))`，NIP 签名
  使用它以实现跨语言一致。

---

## 异常

```typescript
class NpsError           extends Error {}
class NpsFrameError      extends NpsError {}
class NpsCodecError      extends NpsError {}
class NpsAnchorNotFoundError extends NpsError { readonly anchorId: string; }
class NpsAnchorPoisonError   extends NpsError { readonly anchorId: string; }
class NpsStreamError     extends NpsError {}

class NcpError extends Error { readonly code: string; }
```

`NcpError` 携带规范错误码（如 `NCP-STREAM-SEQ-GAP`）。函数式
编解码器、stream manager 和校验器抛它；基于类的编解码器和
缓存抛 `NpsError` 子类。

---

## 状态码

```typescript
import { NpsStatusCodes } from "@labacacia/nps-sdk/core";

NpsStatusCodes.NPS_OK;                     // "NPS-OK"
NpsStatusCodes.NPS_CLIENT_NOT_FOUND;       // "NPS-CLIENT-NOT-FOUND"
NpsStatusCodes.NPS_STREAM_SEQ_GAP;         // "NPS-STREAM-SEQ-GAP"
// …
```

与 `spec/status-codes.md` 对应的常量包。发出 `ErrorFrame` 或
与 `status` 字段比较时使用。

---

## `CryptoProvider`

可插拔异步加密的结构性脚手架（Node `node:crypto` 对比浏览器
`SubtleCrypto`）。今日公共 API 不会实例化它；NIP 目前直接使用
`@noble/ed25519`。导出供下游实现者使用。

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
