[English Version](./nps-sdk.nip.md) | 中文版

# `@labacacia/nps-sdk/nip` — 类与方法参考

> 规范：[NPS-3 NIP v0.9](https://github.com/labacacia/NPS/blob/main/spec/NPS-3-NIP.md)

NIP 是 NPS 的 TLS/PKI。本模块暴露三个身份帧
（`IdentFrame`、`TrustFrame`、`RevokeFrame`）、元数据接口，
以及拥有 Ed25519 密钥对（可选 AES-256-GCM + PBKDF2-SHA256 密钥文件加密）的
`NipIdentity` 辅助类。

---

## 目录

- [`IdentMetadata`](#identmetadata)
- [`IdentFrame` (0x20)](#identframe-0x20)
- [`TrustFrame` (0x21)](#trustframe-0x21)
- [`RevokeFrame` (0x22)](#revokeframe-0x22)
- [`NipIdentity`](#nipidentity)
- [规范化 JSON 与签名格式](#规范化-json-与签名格式)
- [`NipErrorCodes`](#niperrorecodes)

---

## `IdentMetadata`

```typescript
interface IdentMetadata {
  issuer:        string;
  issuedAt:      string;
  expiresAt?:    string;
  capabilities?: readonly string[];
  scopes?:       readonly string[];
}
```

附在 `IdentFrame.metadata`。由 `unsignedDict()` 产生的签名 payload
**排除**此字段 —— 元数据是运行时可变的，不属于 agent 身份本身。

---

## `IdentFrame` (0x20)

Agent 身份证书。作为任何认证 session 的开场帧发送。

```typescript
class IdentFrame {
  readonly frameType:     FrameType.IDENT;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:       string,      // urn:nps:agent:{authority}:{name}
    public readonly pubKey:    string,      // "ed25519:{hex}"
    public readonly metadata:  IdentMetadata,
    public readonly signature: string,      // "ed25519:{base64}"
  );

  unsignedDict(): Record<string, unknown>;   // { nid, pub_key, metadata } — 签名 payload
  toDict():        Record<string, unknown>;   // unsignedDict + signature

  static fromDict(data: Record<string, unknown>): IdentFrame;
}
```

`unsignedDict()` 是规范签名 payload —— 它省略 `signature` 字段。
与 `NipIdentity.sign()` 配对使用以产生自签名 `signature`。

---

## `TrustFrame` (0x21)

跨 CA 信任证书。

```typescript
class TrustFrame {
  readonly frameType:     FrameType.TRUST;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly issuerNid:  string,
    public readonly subjectNid: string,
    public readonly scopes:     readonly string[],
    public readonly expiresAt:  string,      // ISO 8601 UTC
    public readonly signature:  string,      // "ed25519:{base64}"
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): TrustFrame;
}
```

---

## `RevokeFrame` (0x22)

证书吊销。

```typescript
class RevokeFrame {
  readonly frameType:     FrameType.REVOKE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:        string,
    public readonly reason?:    string,     // 如 "key_compromise"
    public readonly revokedAt?: string,     // ISO 8601 UTC
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): RevokeFrame;
}
```

由签发 CA 签名。验证者**必须**拒绝其 `nid` 被有效 `RevokeFrame` 覆盖的
任何 `IdentFrame`。

---

## `NipIdentity`

Ed25519 密钥对管理器，可选加密密钥文件持久化。基于
`@noble/ed25519` + `node:crypto`。

```typescript
class NipIdentity {
  // 工厂
  static generate(): NipIdentity;
  static fromPrivateKey(privKey: Uint8Array): NipIdentity;
  static load(path: string, passphrase: string): NipIdentity;

  // 持久化
  save(path: string, passphrase: string): void;

  // 签名
  sign(payload: Record<string, unknown>): string;            // "ed25519:{base64}"
  verify(payload: Record<string, unknown>, signature: string): boolean;

  // 公钥访问
  readonly pubKey:        Uint8Array;          // 32 字节
  readonly pubKeyString:  string;              // "ed25519:{hex}"
}
```

### 密钥文件格式

`save` / `load` 写入一个版本化的 JSON 信封，包含：

```
{
  version:    1,
  salt:       hex(16 B),
  iv:         hex(12 B),
  ciphertext: hex( AES-GCM(privateKey) || authTag(16 B) ),
  pubKey:     hex(32 B)
}
```

密钥派生：**PBKDF2-SHA256**，600 000 次迭代。
加密：**AES-256-GCM** —— 16 字节认证 tag 追加到 `ciphertext` 字段内的
密文后。

### `generate()`

生成新的 Ed25519 密钥对。不接触磁盘。

### `fromPrivateKey(priv)`

包装已有的 32 字节 Ed25519 私钥（派生匹配的公钥）。

### `load(path, passphrase)`

读取并解密先前保存的密钥文件。若 JSON 信封格式错误、auth tag
无效，或 passphrase 错误，则抛异常。

### `save(path, passphrase)`

加密并写入密钥对到 `path`。文件已存在时被覆盖 —— 先备份。

### `sign(payload)` / `verify(payload, signature)`

规范化 `payload`（键排序、紧凑分隔符），运行 Ed25519，发出
`"ed25519:{base64}"`。`verify` 任何失败时返回 `false` —— 从不抛异常。

---

## 规范化 JSON 与签名格式

SDK 以如下方式规范化签名 payload：

```js
JSON.stringify(payload, Object.keys(payload).sort());
```

- 每一层键按字典序排序。
- `undefined` 键由 `JSON.stringify` 隐式丢弃。
- token 之间无空白。
- 输出 UTF-8 字节馈入 Ed25519 原语。

对 `IdentFrame`，将 `unsignedDict()` 作为 payload —— 它已省略 `signature`。

---

## 端到端示例

```typescript
import {
  IdentFrame, IdentMetadata, NipIdentity,
} from "@labacacia/nps-sdk/nip";

// 1) 一次性：创建密钥对并持久化
const id = NipIdentity.generate();
id.save("./agent.key", "correct horse battery");

// 2) 构造并签名 IdentFrame
const meta: IdentMetadata = {
  issuer:    "urn:nps:ca:example.com:root",
  issuedAt:  new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  capabilities: ["nwp:query", "nop:delegate"],
};

const unsigned = new IdentFrame(
  "urn:nps:agent:example.com:agent-001",
  id.pubKeyString,
  meta,
  "placeholder",
);

const signature = id.sign(unsigned.unsignedDict());
const signed    = new IdentFrame(unsigned.nid, unsigned.pubKey, meta, signature);

// 3) 任何持有相同密钥对（或等价 pubKey）的一方均可验证
const ok = id.verify(signed.unsignedDict(), signed.signature);
// → true
```

---

## `NipErrorCodes`

NIP wire 错误码字符串常量。从 `@labacacia/nps-sdk/nip` 导入。

```typescript
import { NipErrorCodes } from "@labacacia/nps-sdk/nip";
```

| 常量 | Wire 值 | 起始版本 |
|------|---------|----------|
| `NipErrorCodes.IDENT_SIG_INVALID` | `"NIP-IDENT-SIG-INVALID"` | alpha.4 |
| `NipErrorCodes.IDENT_NID_MISMATCH` | `"NIP-IDENT-NID-MISMATCH"` | alpha.4 |
| `NipErrorCodes.IDENT_EXPIRED` | `"NIP-IDENT-EXPIRED"` | alpha.4 |
| `NipErrorCodes.IDENT_REVOKED` | `"NIP-IDENT-REVOKED"` | alpha.4 |
| `NipErrorCodes.TRUST_CHAIN_BROKEN` | `"NIP-TRUST-CHAIN-BROKEN"` | alpha.4 |
| `NipErrorCodes.TRUST_SCOPE_VIOLATION` | `"NIP-TRUST-SCOPE-VIOLATION"` | alpha.4 |
| `NipErrorCodes.ACME_CHALLENGE_FAILED` | `"NIP-ACME-CHALLENGE-FAILED"` | alpha.4 |
| `NipErrorCodes.ACME_ORDER_EXPIRED` | `"NIP-ACME-ORDER-EXPIRED"` | alpha.4 |
| `NipErrorCodes.X509_CERT_INVALID` | `"NIP-X509-CERT-INVALID"` | alpha.4 |
| `NipErrorCodes.X509_CHAIN_UNTRUSTED` | `"NIP-X509-CHAIN-UNTRUSTED"` | alpha.4 |
| `NipErrorCodes.REPUTATION_LOG_UNREACHABLE` | `"NIP-REPUTATION-LOG-UNREACHABLE"` | alpha.4 |
| `NipErrorCodes.REPUTATION_GOSSIP_FORK` | `"NIP-REPUTATION-GOSSIP-FORK"` | **alpha.5** |
| `NipErrorCodes.REPUTATION_GOSSIP_SIG_INVALID` | `"NIP-REPUTATION-GOSSIP-SIG-INVALID"` | **alpha.5** |

`REPUTATION_GOSSIP_FORK`：跨节点 STH 一致性检查失败时返回。
`REPUTATION_GOSSIP_SIG_INVALID`：gossip 交换中对端 STH 签名验证失败时返回。
