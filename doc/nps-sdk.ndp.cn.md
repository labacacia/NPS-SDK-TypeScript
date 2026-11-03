[English Version](./nps-sdk.ndp.md) | 中文版

# `@labacacia/nps-sdk/ndp` — 类与方法参考

> 规范：[NPS-4 NDP v0.8](https://github.com/labacacia/NPS/blob/main/spec/NPS-4-NDP.md)

NDP 是发现层 —— NPS 对应 DNS 的组件。本模块提供三种 NDP 帧类型、
带惰性 TTL 过期的线程安全内存注册表，以及 announce 签名校验器。

---

## 目录

- [辅助接口](#辅助接口)
- [`AnnounceFrame` (0x30)](#announceframe-0x30)
- [`ResolveFrame` (0x31)](#resolveframe-0x31)
- [`GraphFrame` (0x32)](#graphframe-0x32)
- [`InMemoryNdpRegistry`](#inmemoryndpregistry)
- [`NdpAnnounceValidator`](#ndpannouncevalidator)
- [`NdpAnnounceResult`](#ndpannounceresult)

---

## 辅助接口

```typescript
interface NdpAddress {
  host:     string;
  port:     number;
  protocol: string;         // "nwp" | "nwp+tls"
}

interface NdpGraphNode {
  nid:          string;
  addresses:    readonly NdpAddress[];
  capabilities: readonly string[];
  nodeType?:    string;     // "memory" | "action" | …
}

interface NdpResolveResult {
  host:             string;
  port:             number;
  ttl:              number;                // 秒
  certFingerprint?: string;                // "sha256:{hex}"
}
```

---

## `AnnounceFrame` (0x30)

发布节点的物理可达性与 TTL（NPS-4 §3.1）。

```typescript
class AnnounceFrame {
  readonly frameType:     FrameType.ANNOUNCE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:          string,
    public readonly addresses:    readonly NdpAddress[],
    public readonly capabilities: readonly string[],
    public readonly ttl:          number,          // 0 = 有序下线
    public readonly timestamp:    string,          // ISO 8601 UTC
    public readonly signature:    string,          // "ed25519:{base64}"
    public readonly nodeType?:    string,
  );

  unsignedDict(): Record<string, unknown>;   // 签名 payload（无 signature）
  toDict():        Record<string, unknown>;

  static fromDict(data: Record<string, unknown>): AnnounceFrame;
}
```

签名流程：

1. 调用 `frame.unsignedDict()` —— 剥离 `signature`。
2. 用 `NipIdentity.sign(dict)` 以该 NID 自己的私钥签名（与支持其
   `IdentFrame` 的相同密钥）。
3. `ttl = 0` **必须**在有序下线前发布，以便订阅者清除条目。

---

## `ResolveFrame` (0x31)

解析 `nwp://` URL 的请求 / 响应信封。

```typescript
class ResolveFrame {
  readonly frameType:     FrameType.RESOLVE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly target:        string,           // "nwp://api.example.com/products"
    public readonly requesterNid?: string,
    public readonly resolved?:     NdpResolveResult, // 响应时填充
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): ResolveFrame;
}
```

Resolve 流量首选 JSON tier —— 量小且便于人类调试。

---

## `GraphFrame` (0x32)

注册表之间的拓扑同步。

```typescript
class GraphFrame {
  readonly frameType:     FrameType.GRAPH;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly seq:         number,                   // 每个发布者严格单调
    public readonly initialSync: boolean,
    public readonly nodes?:      readonly NdpGraphNode[],  // 全量快照
    public readonly patch?:      readonly Record<string, unknown>[], // RFC 6902 JSON Patch
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): GraphFrame;
}
```

`seq` 跳号**必须**触发重新同步请求，信号为 `NDP-GRAPH-SEQ-GAP`。

---

## `InMemoryNdpRegistry`

线程安全、按 TTL 过期的注册表。过期是在每次读取时**惰性**评估 ——
没有后台定时器。

```typescript
class InMemoryNdpRegistry {
  // 为确定性测试可替换
  clock: () => number;

  announce(frame: AnnounceFrame): void;
  getByNid(nid: string): AnnounceFrame | undefined;
  resolve(target: string): NdpResolveResult | undefined;
  getAll(): AnnounceFrame[];

  static nwpTargetMatchesNid(nid: string, target: string): boolean;
}
```

### 行为

- `announce` 若 `ttl === 0` 立即清除该 NID；否则以绝对过期
  `clock() + ttl*1000` 插入 / 刷新条目。
- `resolve` 扫描活跃条目，找到第一个覆盖 `target` 的 NID，返回其
  第一个广告地址包装为 `NdpResolveResult`。
- `getByNid` 精确 NID 查询，按需清理。
- 测试中覆写 `clock`：`registry.clock = () => 1000_000;`

### `nwpTargetMatchesNid(nid, target)` *(静态)*

NID ↔ target 覆盖规则：

```
NID:    urn:nps:node:{authority}:{name}
Target: nwp://{authority}/{name}[/subpath]
```

节点 NID 覆盖某 target 的条件：

1. Target scheme 为 `nwp://`。
2. NID authority 等于 target authority（精确，区分大小写）。
3. Target path 等于 `{name}` 或以 `{name}/` 开头。

输入格式错误时返回 `false` 而非抛异常。

---

## `NdpAnnounceValidator`

使用已注册的 Ed25519 公钥校验 `AnnounceFrame.signature`。

```typescript
class NdpAnnounceValidator {
  registerPublicKey(nid: string, encodedPubKey: string): void;
  removePublicKey(nid: string): void;

  readonly knownPublicKeys: ReadonlyMap<string, string>;

  validate(frame: AnnounceFrame): NdpAnnounceResult;
}
```

`validate`（NPS-4 §7.1）：

1. 在已注册密钥中查找 `frame.nid`。缺失 →
   `NdpAnnounceResult.fail("NDP-ANNOUNCE-NID-MISMATCH", …)`。期望的
   工作流程：先校验广告方的 `IdentFrame`，然后把其 `pubKeyString`
   注册到此处。
2. 用键排序规范形式从 `frame.unsignedDict()` 重建签名 payload。
3. 运行 Ed25519 verify。
4. 成功返回 `NdpAnnounceResult.ok()`；失败返回
   `NdpAnnounceResult.fail("NDP-ANNOUNCE-SIG-INVALID", …)`。

编码后的密钥**必须**使用 `NipIdentity.pubKeyString` 产生的
`ed25519:{hex}` 形式。

---

## `NdpAnnounceResult`

```typescript
interface NdpAnnounceResult {
  isValid:    boolean;
  errorCode?: string;
  message?:   string;
}

const NdpAnnounceResult: {
  ok():                                NdpAnnounceResult;
  fail(errorCode: string, message: string): NdpAnnounceResult;
};
```

---

## 端到端示例

```typescript
import { NipIdentity } from "@labacacia/nps-sdk/nip";
import {
  AnnounceFrame, InMemoryNdpRegistry, NdpAnnounceValidator,
} from "@labacacia/nps-sdk/ndp";

const id  = NipIdentity.generate();
const nid = "urn:nps:node:api.example.com:products";

// 构造并签名 announce
const unsigned = new AnnounceFrame(
  nid,
  [{ host: "10.0.0.5", port: 17433, protocol: "nwp+tls" }],
  ["nwp:query", "nwp:stream"],
  300,
  new Date().toISOString(),
  "placeholder",
  "memory",
);
const signature = id.sign(unsigned.unsignedDict());
const signed    = new AnnounceFrame(
  unsigned.nid,  unsigned.addresses, unsigned.capabilities,
  unsigned.ttl,  unsigned.timestamp, signature, unsigned.nodeType,
);

// 校验 + 注册
const validator = new NdpAnnounceValidator();
validator.registerPublicKey(nid, id.pubKeyString);
const result = validator.validate(signed);
if (!result.isValid) throw new Error(result.errorCode);

const registry = new InMemoryNdpRegistry();
registry.announce(signed);

const resolved = registry.resolve("nwp://api.example.com/products/items/42");
// → { host: "10.0.0.5", port: 17433, ttl: 300 }
```
