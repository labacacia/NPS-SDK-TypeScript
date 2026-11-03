# alpha.20 实验性实现片段

这些辅助模块尚未接入现有 HTTP/native 服务端，也不是稳定的 profile 公共 API，
不会自动通过 Hello/NWM 宣告支持，不能据此认定 SDK 已完成 alpha.20 验收。
规范基线为 NIP §7.8 / NWP §9.7 / NCP §2.6.3；跟踪 P20-203 / NPS-Dev #130。

## 投影准入

`src/alpha20/context-admission.ts` 串联严格 carrier/schema 解析、当前配置密钥的
Ed25519 验签、独立通道的 issuer 绑定、精确 audience/subject/请求绑定、接收端授权上限、
已注册操作校验、授权、时间检查及原子重放登记。任一失败都不会返回已准入上下文，
也不会向调用方泄露后端异常细节。

`InvocationAdmissionOptions` 全部来自接收端可信配置，不能从线上字段照抄。
尤其 `allowedIssuers` 必须由独立认证的通道身份得出，不能取自投影 issuer 或公共请求头。
`selectedFeatures` 必须来自已准入的 native 协商或独立证明已强制执行的 HTTP 路由。
`validateOperation` 只做无业务副作用的 schema/绑定校验，`authorize` 执行接收端策略；
二者均不得执行业务 action。异步授权后、重放登记前会重新检查密钥、策略绑定和有效期。

只有 `admitInvocationProjection` 成功后才能派发，并使用返回的冻结 `request`。
不要重新解析原始请求而引入另一套数字语义。此 API 不派发 handler、不创建出站投影、
不清理公共入口请求头、不协商传输，也不提供取消/截止时间/重试编排；这些接入仍是必需项。
仅调用 `checkProjectionSignature` 不能完成准入。

## 单主机持久重放存储

`SqliteProjectionReplayStore.open(absolutePath, { audience, capacity })` 使用已有的可选
Node SQLite 平台（Node >=22.13，无需开关导入 `node:sqlite`），要求应用专用的本地绝对路径，拒绝内存库及相对路径。
新文件权限为 0600；不替换或修改既有文件权限。

同一 audience 的副本必须共享同一个本地文件。audience 与容量会持久化，打开或登记时
配置不匹配则拒绝。默认容量为 65,536 个有效条目。`BEGIN IMMEDIATE`、WAL 和
synchronous FULL 提交串行化登记；获得写锁后才读取准入时钟。即使采用更小的准入偏差，
条目也保留到 `expires_at + 5`。容量满不淘汰有效 ID；锁等待上限 250ms，存储故障
均关闭准入。持久化时钟高水位用于拒绝时钟倒退。

这不是多主机存储、网络文件系统协议或数据库快照回滚检测器。各自独立的文件无法保护
负载均衡后的 audience。多主机必须另行验收共享的 `ProjectionReplayStore` 实现，
没有静默降级到内存的路径。防重放不等于业务幂等，也不能证明 action 是否已经执行。

## 证据与后续

测试覆盖严格解析、密码学绑定、重放登记前的策略/时间拒绝、并发准入、真实 SQLite
重开/容量/时钟/锁故障、两个子进程共享同库，以及子进程强制终止后的恢复。
测试仅使用公开的合成密钥和临时数据库。这不代表六 SDK 的 context 对齐、多主机故障切换、
daemon/adopter 完整验收或 beta 清洁观察期完成；仍不宣告生产 profile 支持。

## 包导入

通过 `@labacacia/nps-sdk/alpha20` 导入实验性解析、精确字节检查和接收方配置的
准入函数。持久化重放实现单独从 `@labacacia/nps-sdk/alpha20/sqlite` 导入，普通
入口无需加载 `node:sqlite`。SQLite 子路径要求 Node 22.13 或更高版本，仍受上述
单机边界限制。导出函数不代表已声明特性支持，也不会为传输路由自动安装准入。
