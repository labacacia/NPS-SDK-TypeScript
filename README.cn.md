[English Version](./README.md) | 中文版

# @labacacia/nps-sdk — TypeScript / Node.js
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)
[![Release](https://img.shields.io/badge/release-v1.0.0--alpha.16-orange.svg)](../../CHANGELOG.cn.md)
[![NCP](https://img.shields.io/badge/NCP-v0.9-5b8cff.svg)]()
[![NWP](https://img.shields.io/badge/NWP-v0.14-4af0b0.svg)]()
[![NIP](https://img.shields.io/badge/NIP-v0.10-7b61ff.svg)]()
[![NDP](https://img.shields.io/badge/NDP-v0.9-f0a050.svg)]()
[![NOP](https://img.shields.io/badge/NOP-v0.7-ff8c42.svg)]()

面向 **Neural Protocol Suite (NPS)** 的 TypeScript SDK —— 为 AI Agent 设计的协议族。
属 [LabAcacia](https://github.com/LabAcacia) / INNO LOTUS PTY LTD 开源生态。

## 状态

**v1.0.0-alpha.16 — RFC-0002 跨 SDK 端口波（第三棒）** · 5 个协议 · 271 个测试 · 覆盖率 ≥ 98%

Alpha.14 候选新增：远程 NIP CA 类型化客户端（`NipCaClient`）、native-mode NWP 服务端 helper（`NwpNativeNodeServer`）和 TC-N1/TC-N2 一致性 manifest helper（`@labacacia/nps-sdk/conformance`）。

| 协议 | 类 | 状态 |
|------|----|------|
| NCP — Neural Communication Protocol | 帧、编解码器 | ✅ |
| NWP — Neural Web Protocol | `NwpClient`、`NwpNativeNodeServer` | ✅ |
| NIP — Neural Identity Protocol | `NipIdentity`、`NipIdentVerifier`（RFC-0002 §8.1 双信任）、`AssuranceLevel`（RFC-0003）、`nip.x509` + `nip.acme` | ✅ |
| NDP — Neural Discovery Protocol | `InMemoryNdpRegistry`、`NdpAnnounceValidator` | ✅ |
| NOP — Neural Orchestration Protocol | `NopClient` | ✅ |

**早期新增** —— 完整的 NPS-RFC-0002 X.509 + ACME `agent-01` NID 证书原语：

- `nip.x509` —— `issueLeaf` / `issueRoot` / `verify`（基于 `@peculiar/x509` + 原生 Web Crypto Ed25519）。
- `nip.acme` —— `AcmeClient` + 进程内 `AcmeServer` + JWS / messages helpers（RFC 8555 + RFC 8037 EdDSA）。
- `IdentFrame` 扩展非破坏性可选构造参数 `assuranceLevel` / `certFormat` / `certChain`；v1 verifier 忽略新字段。

## main 分支未发布内容

`main` 分支额外携带 **alpha.16 周期的服务端面 parity 移植**（尚未进入任何已发布包；随下一个套件版本发布）：

- **NOP 编排引擎** —— DAG 校验器、条件求值器、输入映射、结果聚合、任务存储、Worker 客户端、回调校验、instrumentation
- **NCP 原生模式传输** —— server、session、client、帧 IO、握手 caps、编码策略、patch 格式
- **NIP CA 服务** —— CA router + RA 准入模型、SQL CA store、TrustFrame 校验器、完整六步 §7 `VerifyFull` 验证器
- **NWP 服务端面**扩展（memory/complex node 服务）
- **Daemon observability**（health / metrics / logging / shutdown）与 **telemetry**

## 安装

```bash
npm install @labacacia/nps-sdk@alpha
```

Alpha 版本发布在 npm 的 `alpha` dist-tag 上；`latest` 保留给默认/稳定安装通道。

> **对等依赖：** Node.js 22+

## 快速开始

### NWP —— 查询节点

```typescript
import { NwpClient, QueryFrame } from "@labacacia/nps-sdk/nwp";

const client = new NwpClient("http://node.example.com:17433");
const caps   = await client.query(new QueryFrame("sha256:<anchor-id>", { active: true }, 20));
console.log(caps.count, caps.data);
```

### NWP —— 流式结果

```typescript
for await (const chunk of client.stream(new QueryFrame("sha256:<anchor-id>"))) {
  console.log(chunk.seq, chunk.data);
}
```

### NWP —— 调用 Action

```typescript
import { ActionFrame } from "@labacacia/nps-sdk/nwp";

const result = await client.invoke(new ActionFrame("summarise", { maxTokens: 500 }));
```

### NWP —— native 服务端

```typescript
import { NwpNativeNodeServer } from "@labacacia/nps-sdk/nwp";

const server = new NwpNativeNodeServer({
  queryHandler: () => [{ id: 42 }],
  actionHandler: (action) => ({ action: action.actionId }),
});

// `source`/`sink` 已完成 NCP preamble、TLS 和 Hello negotiation。
await server.serve(source, sink);
```

### NIP —— Ed25519 身份

```typescript
import { NipIdentity } from "@labacacia/nps-sdk/nip";

// 生成并持久化
const id = NipIdentity.generate();
id.save("./my-key.json", process.env.KEY_PASS!);

// 加载并签名
const loaded = NipIdentity.load("./my-key.json", process.env.KEY_PASS!);
const sig    = loaded.sign({ action: "announce", nid: "urn:nps:node:example.com:data" });
const ok     = loaded.verify({ action: "announce", nid: "urn:nps:node:example.com:data" }, sig);
```

### NIP —— 远程 CA Client

```typescript
import { NipCaClient } from "@labacacia/nps-sdk/nip";

const ca = new NipCaClient("https://ca.example.com", { routePrefix: "/nip" });
const discovery = await ca.getDiscovery();
const ident = await ca.registerAgent(
  { identifier: "agent-a", pub_key: "ed25519:<pub>", capabilities: ["nwp:query"] },
  "token",
);
const status = await ca.verifyAgent(ident.nid);
```

### 一致性 Manifest

```typescript
import {
  NODE_L1,
  catalogForProfile,
  createConformanceManifest,
  validateConformanceManifest,
} from "@labacacia/nps-sdk/conformance";

const results = catalogForProfile(NODE_L1).map((c) => ({ id: c.id, result: "pass" as const }));
const manifest = createConformanceManifest({
  profile: NODE_L1,
  iutName: "my-node",
  iutVersion: "1.0.0-alpha.16",
  iutNid: "urn:nps:node:example.com:my-node",
  peerName: "labacacia-fixture",
  peerVersion: "1.0.0-alpha.16",
  results,
});
const validation = validateConformanceManifest(manifest);
```

### NDP —— 注册表和签名校验

```typescript
import { InMemoryNdpRegistry, NdpAnnounceValidator } from "@labacacia/nps-sdk/ndp";
import { AnnounceFrame } from "@labacacia/nps-sdk/ndp";

const registry  = new InMemoryNdpRegistry();
const validator = new NdpAnnounceValidator();
validator.registerPublicKey(nid, identity.pubKeyString);

registry.announce(frame);
const resolved = registry.resolve("nwp://example.com/data/items");
```

### NOP —— 提交并等待任务

```typescript
import { NopClient, TaskFrame } from "@labacacia/nps-sdk/nop";

const client = new NopClient("http://orchestrator.example.com:17433");
const dag    = {
  nodes: [{ id: "classify", action: "classify-text", agent: "urn:nps:node:ml.example.com:classifier" }],
  edges: [],
};

const taskId = await client.submit(new TaskFrame("my-task-1", dag));
const status = await client.wait(taskId, { timeoutMs: 30_000 });
console.log(status.state, status.aggregatedResult);
```

## 包导出

```typescript
import { ... } from "@labacacia/nps-sdk";           // 全部
import { ... } from "@labacacia/nps-sdk/core";       // codec、帧、registry、cache
import { ... } from "@labacacia/nps-sdk/ncp";        // AnchorFrame、CapsFrame、StreamFrame、HelloFrame、…
import { ... } from "@labacacia/nps-sdk/nwp";        // NwpClient、QueryFrame、ActionFrame
import { ... } from "@labacacia/nps-sdk/nip";        // NipIdentity、IdentFrame、TrustFrame、RevokeFrame
import { ... } from "@labacacia/nps-sdk/ndp";        // InMemoryNdpRegistry、NdpAnnounceValidator、AnnounceFrame、…
import { ... } from "@labacacia/nps-sdk/nop";        // NopClient、NopTaskStatus、TaskFrame、…
import { ... } from "@labacacia/nps-sdk/conformance"; // TC-N1/TC-N2 目录和 manifest 校验器
```

## NCP 编解码

编解码层支持 Tier-1/2/3 编码和对线上字节的直接操作。覆盖编码 Tier 主要用于已协商的会话策略、诊断和测试；应用代码不应在同一业务流程中随意切换 Tier。

```typescript
import { NpsFrameCodec, EncodingTier } from "@labacacia/nps-sdk/core";
import { createDefaultRegistry } from "@labacacia/nps-sdk";

const codec = new NpsFrameCodec(createDefaultRegistry());

// 编码（默认 MsgPack）
const wire = codec.encode(frame);

// 编码为 JSON（调试 / 互操作策略）
const json = codec.encode(frame, { overrideTier: EncodingTier.JSON });

// 解码
const decoded = codec.decode(wire);

// 仅读取帧头，不解码 payload
const header = NpsFrameCodec.peekHeader(wire);
console.log(header.frameType, header.isExtended, header.payloadLength);
```

## 开发

```bash
# 安装
npm install

# 测试
npm test

# 测试 + 覆盖率
npm run test -- --coverage

# 构建（ESM + CJS）
npm run build
```

## 许可证

Apache 2.0 —— 详见 [LICENSE](https://github.com/labacacia/NPS-Dev/blob/main/LICENSE)。
