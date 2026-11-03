[English Version](./overview.md) | 中文版

# `@labacacia/nps-sdk` — API 参考总览

[![npm alpha](https://img.shields.io/npm/v/@labacacia/nps-sdk/alpha)](https://www.npmjs.com/package/@labacacia/nps-sdk)

NPS TypeScript SDK 是 .NET 参考实现的双格式（ESM + CJS）移植。本文档是
各模块 API 参考的入口 —— 每个协议有独立文件，见下。

---

## 包结构

```
@labacacia/nps-sdk
├── /           # 根：VERSION、createDefaultRegistry、createFullRegistry
├── /core       # 线缆原语：FrameHeader、编解码、AnchorFrame 缓存、错误
├── /ncp        # NCP 帧 + 握手 + 流管理
├── /nwp        # NWP 帧 + 异步 NwpClient
├── /nip        # NIP 帧 + NipIdentity（Ed25519）
├── /ndp        # NDP 帧 + InMemoryNdpRegistry + 验证器
└── /nop        # NOP 帧 + TaskDag 模型 + NopClient
```

## 参考文档

| 子路径 | 模块 | 参考文档 |
|--------|------|----------|
| —                        | 根辅助函数与注册表工厂      | 本文件 |
| `@labacacia/nps-sdk/core` | 帧头、编解码、AnchorFrame 缓存、异常 | [`nps-sdk.core.cn.md`](./nps-sdk.core.cn.md) |
| `@labacacia/nps-sdk/ncp`  | NCP 帧集（`AnchorFrame`、`DiffFrame`、`StreamFrame`、`CapsFrame`、`ErrorFrame`、`HelloFrame`） | [`nps-sdk.ncp.cn.md`](./nps-sdk.ncp.cn.md) |
| `@labacacia/nps-sdk/nwp`  | `QueryFrame`、`ActionFrame`、`NwpClient` | [`nps-sdk.nwp.cn.md`](./nps-sdk.nwp.cn.md) |
| `@labacacia/nps-sdk/nip`  | `IdentFrame`、`TrustFrame`、`RevokeFrame`、`NipIdentity` | [`nps-sdk.nip.cn.md`](./nps-sdk.nip.cn.md) |
| `@labacacia/nps-sdk/ndp`  | `AnnounceFrame`、`ResolveFrame`、`GraphFrame`、注册表、验证器 | [`nps-sdk.ndp.cn.md`](./nps-sdk.ndp.cn.md) |
| `@labacacia/nps-sdk/nop`  | Task DAG、`TaskFrame`、`DelegateFrame`、`SyncFrame`、`AlignStreamFrame`、`NopClient` | [`nps-sdk.nop.cn.md`](./nps-sdk.nop.cn.md) |

---

## 安装

```bash
npm install @labacacia/nps-sdk@alpha
```

Alpha 版本发布在 npm 的 `alpha` dist-tag 上；`latest` 保留给默认/稳定安装通道。

要求 **Node.js 18+**（Web Crypto）或支持原生 `crypto.subtle` 的
现代浏览器。

---

## 根模块

```typescript
import { VERSION, createDefaultRegistry, createFullRegistry } from "@labacacia/nps-sdk";
```

- `VERSION` —— SDK 版本常量。
- `createDefaultRegistry()` —— 只含 NCP 帧（`ANCHOR`、`DIFF`、`STREAM`、`CAPS`、`ERROR`）的新 `FrameRegistry`。
- `createFullRegistry()` —— 预注册全部五个协议（NCP + NWP + NIP + NDP + NOP）的新 `FrameRegistry`。
  解码任意帧时使用这个。

```typescript
const registry = createFullRegistry();
```

---

## 最小端到端示例

```typescript
import { NwpClient, QueryFrame, ActionFrame } from "@labacacia/nps-sdk/nwp";

const client = new NwpClient("http://node.example.com:17433");

// 分页查询
const caps = await client.query(
  new QueryFrame("sha256:<anchor-id>", { active: true }, 50),
);
console.log(caps.count, caps.data);

// 流式查询
for await (const chunk of client.stream(new QueryFrame("sha256:<anchor-id>"))) {
  console.log(chunk.seq, chunk.data);
  if (chunk.isLast) break;
}

// Action 调用
const result = await client.invoke(
  new ActionFrame("summarise", { maxTokens: 500 }),
);
```

---

## 编码分层

每个帧都有 `preferredTier`。MsgPack 是生产默认；JSON Tier
留给诊断。

| Tier | `EncodingTier` 值 | 说明 |
|------|---------------------|------|
| Tier-1 JSON    | `0x00` | UTF-8 JSON。开发与兼容。 |
| Tier-2 MsgPack | `0x01` | MessagePack 二进制。**生产默认** —— 约小 60%。 |

```typescript
import { EncodingTier } from "@labacacia/nps-sdk/core";
import { NpsFrameCodec } from "@labacacia/nps-sdk/core";

const codec = new NpsFrameCodec(createFullRegistry());
const wire  = codec.encode(frame, { overrideTier: EncodingTier.JSON });
```

---

## 异步约定

- 所有面向网络的客户端（`NwpClient`、`NopClient`）返回 `Promise<T>`。
- 流式使用 `AsyncGenerator<StreamFrame>` —— 用
  `for await (const chunk of …) { … }` 消费。
- 客户端 **无需** 显式 dispose —— 底层 `fetch` 拥有连接生命周期。

---

## 错误层级

```
Error
└── NpsError                       来自 "@labacacia/nps-sdk/core"
    ├── NpsFrameError              —— 帧头解析 / 结构错误
    ├── NpsCodecError              —— 编解码失败
    ├── NpsAnchorNotFoundError     —— AnchorFrame 不在缓存
    ├── NpsAnchorPoisonError       —— anchor_id / schema 不一致
    └── NpsStreamError             —— 流序号跳跃 / 未知流 id
```

`NcpError`（来自 `@labacacia/nps-sdk/core`）是一个独立的协议级错误，
携带机器可读的 `code`（如 `NCP-ANCHOR-NOT-FOUND`、
`NCP-STREAM-SEQ-GAP`）。

---

## 参考规范

| 模块 | 规范 |
|------|------|
| `core` + `ncp` | [NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.cn.md) |
| `nwp`          | [NPS-2 NWP v0.13](https://github.com/labacacia/NPS/blob/main/spec/NPS-2-NWP.cn.md) |
| `nip`          | [NPS-3 NIP v0.9](https://github.com/labacacia/NPS/blob/main/spec/NPS-3-NIP.cn.md) |
| `ndp`          | [NPS-4 NDP v0.8](https://github.com/labacacia/NPS/blob/main/spec/NPS-4-NDP.cn.md) |
| `nop`          | [NPS-5 NOP v0.6](https://github.com/labacacia/NPS/blob/main/spec/NPS-5-NOP.cn.md) |
