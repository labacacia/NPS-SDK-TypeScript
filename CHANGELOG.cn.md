[English Version](./CHANGELOG.md) | 中文版

# 变更日志 —— TypeScript SDK (`@labacacia/nps-sdk`)

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

在 NPS 达到 v1.0 稳定版之前，套件内所有仓库同步使用同一个预发布版本号。

---

## [1.0.0-alpha.20] — 发布候选，尚未发布

- 有边界实验：结果资源/授权、重复schema批次、本地任务交接和易失节点转移；各语言支持范围不同，未承诺六SDK完整运行时一致性。
- 保留与等价HTTPgzip及普通工具的真实测量；不宣称固定token、费用或速度收益。
- 候选使用统一版本、本地CI与独立包验证；完整生产能力、beta和实际发布保持后续门槛。

## [Unreleased]

- 更新 Vitest 及受影响的 Vite/mocker/source-map 依赖，运行时 API 和功能声明不变。

## [1.0.0-alpha.19] —— 2026-09-05

### 新增

- 新增公开的 `./alpha19` 策略入口，并可执行全部 47 条共享 NCP/NWP/NIP/NDP/NOP 加固向量，覆盖负向路径与 fixture 之外的边界分支。

### 变更

- 将 Node L2 扩展到 v0.7/38 cases，纳入当前 AaaS L2-01..L2-07；L2-01..05
  为强制项，L2-06/07 记 `na` 时必须携带有理由的 message。
- 将 Node L2 manifest 对齐 v0.6 与全部 31 个 case；validation 现会强制校验
  summary 完整性、整族适用性以及 single-/multi-Anchor HA 互斥约束。
- 注册 alpha.19 新增的协议错误码及其规范 NPS 状态映射。

## [1.0.0-alpha.18] —— 2026-08-15

### 新增

- 新增官方有状态 LLM context DTO、进程内 store 与 Fetch Action Server coordinator，覆盖 owner 隔离、CAS reservation、生命周期 action、真异步执行、取消和 19 个共享一致性向量。

### 变更

- 跨 SDK 统一 unary request correlation、LLM usage 记账、严格有状态请求校验、任务所有权与晚到结果拒绝。
- runtime `VERSION` 改为从 package metadata 派生，避免包版本与 API 版本漂移。

## [1.0.0-alpha.17] —— 2026-08-02

### 新增

- 将参考服务端能力移植到 TypeScript SDK：NCP 原生传输、NWP action/complex/memory node 与双向 Bridge、NIP CA 服务及完整验证、NOP 编排、daemon 可观测性和 telemetry。
- 通过 `./daemon` 包子路径导出 daemon 可观测性能力。
- 实现共享的 NCP 0.11、NWP 0.20、NIP 0.13、NDP 0.12 与 NOP 0.9
  可移植 Profile，并执行语言无关一致性 fixture。

### 安全

- 更新锁定的 Vitest/Vite/PostCSS/esbuild 工具链，清除 npm audit 报告的全部问题。

## [1.0.0-alpha.16] —— 2026-07-23

### 变更

- 完成套件级 alpha.16 源码同步与协议兼容性更新。

## [1.0.0-alpha.15] —— 2026-06-28

### 变更

- 套件级 alpha.15 同步：对齐包元数据、当前 README / 版本 banner、分发源树以及 release-prep 说明到 NPS-Dev。
- 承载源事实树中的 NCP Tier-3 BinaryVector、入站 NWP Bridge server 加固、NIP canonical trust/revoke，以及 NDP discovery canonical-form 对齐。

## [1.0.0-alpha.14] —— 2026-06-26

### Added

- `@labacacia/nps-sdk/nip` 下新增 `NipCaClient`：远程 NIP CA 的类型化客户端，覆盖 discovery、CRL、agent/node 注册、X.509 注册、续签、撤销和校验。
- `@labacacia/nps-sdk/nwp` 下新增 `NwpNativeNodeServer`：native-mode NWP 服务端 helper，用于在已建立的 NCP stream 上分发 QueryFrame/ActionFrame。
- `@labacacia/nps-sdk/conformance`：TC-N1/TC-N2 一致性用例目录、manifest helper 和校验器，用于 CI/自认证流程。

---

## [1.0.0-alpha.11] —— 2026-05-28

### 新增

- NOP saga compensation、`WEIGHTED_FIRST_K` / `MERGE_ALL`、cross-cluster delegate 与 AlignStream Ack/Nak。
- NDP security profile、60 秒 ephemeral TTL、AnnounceFrame 字段及 GraphFrame/GraphEdge §5 结构。
- NIP reputation metadata 与 OCSP staple；NWP SubscribeFrame 与 NWM `trust_anchors`。

---

## [1.0.0-alpha.2] —— 2026-04-19

### Fixed

- **`NpsFrameCodec is not a constructor`** —— `src/core/index.ts` 现显式从 `./codec.js`、`./registry.js`、`./cache.js` 重新导出随包提供的 OOP API（`NpsFrameCodec`、`Tier1JsonCodec`、`Tier2MsgPackCodec`、`FrameRegistry`、`AnchorFrameCache`）。`./codecs/` 下的并行函数式 API 仍可通过直接路径导入，但不再自动导出（与类 API 在 `FrameType` / `EncodingTier` / `FrameHeader` 上冲突）。
- **缺失的 Ed25519 运行时依赖** —— `@noble/ed25519` 和 `@noble/hashes` 现已声明为运行时依赖。此前已被 `src/nip/identity.ts` 和 `src/ndp/validator.ts` import 但 `package.json` 未声明，导致 npm 消费者安装失败。

### Added

- **HelloFrame（NCP 0x06）** —— `src/ncp/frames.ts` 新增 `HelloFrame` 类（snake_case toDict/fromDict），在 `ncp/registry.ts` 中注册。`FrameType.HELLO = 0x06` 加入枚举。
- **subpath exports** —— `package.json` 的 `exports` 映射新增 `./nwp`、`./nip`、`./ndp`、`./nop`（此前仅声明 `.`、`./core`、`./ncp`，但 README 已示例使用全部六个）。

### Changed

- Node 引擎要求升级到 `>=22.0.0`。
- 264 测试全绿（此前为 158 通过 + 5 个文件失败 + 1 个测试失败）。

### 涵盖模块

- core / ncp / nwp / nip / ndp / nop

---

## [1.0.0-alpha.1] —— 2026-04-10

作为 NPS 套件 `v1.0.0-alpha.1` 的一部分首次公开 alpha。

[1.0.0-alpha.2]: https://github.com/LabAcacia/nps/releases/tag/v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/LabAcacia/nps/releases/tag/v1.0.0-alpha.1
