[English Version](./nps-sdk.nop.md) | 中文版

# `@labacacia/nps-sdk/nop` — 类与方法参考

> 规范：[NPS-5 NOP v0.6](https://github.com/labacacia/NPS/blob/main/spec/NPS-5-NOP.md)

NOP 是编排层 —— 提交一个委托子任务 DAG、等待完成、流式拉回结果。
本模块提供四个 NOP 帧（0x40–0x43）、任务模型（`TaskDag`、`DagNode`、
`DagEdge`、`RetryPolicy`、`TaskContext`），以及异步 `NopClient` + `NopTaskStatus`。

---

## 目录

- [枚举与常量](#枚举与常量)
- [`RetryPolicy`](#retrypolicy)
- [`TaskContext`](#taskcontext)
- [`DagNode` / `DagEdge` / `TaskDag`](#dagnode--dagedge--taskdag)
- [`TaskFrame` (0x40)](#taskframe-0x40)
- [`DelegateFrame` (0x41)](#delegateframe-0x41)
- [`SyncFrame` (0x42)](#syncframe-0x42)
- [`AlignStreamFrame` (0x43)](#alignstreamframe-0x43)
- [`NopClient`](#nopclient)
- [`NopTaskStatus`](#noptaskstatus)

---

## 枚举与常量

```typescript
enum TaskState {
  PENDING       = "pending",
  PREFLIGHT     = "preflight",
  RUNNING       = "running",
  WAITING_SYNC  = "waiting_sync",
  COMPLETED     = "completed",
  FAILED        = "failed",
  CANCELLED     = "cancelled",
  SKIPPED       = "skipped",
}

enum TaskPriority      { LOW = "low", NORMAL = "normal", HIGH = "high" }
enum BackoffStrategy   { FIXED = "fixed", LINEAR = "linear", EXPONENTIAL = "exponential" }
enum AggregateStrategy { MERGE = "merge", FIRST = "first", FASTEST_K = "fastest_k", ALL = "all" }
```

终态为 `COMPLETED`、`FAILED`、`CANCELLED`。`NopTaskStatus.isTerminal`
使用此集合。

---

## `RetryPolicy`

```typescript
interface RetryPolicy {
  maxRetries:   number;
  backoff:      BackoffStrategy;
  baseDelayMs?: number;   // 默认 1 000
  maxDelayMs?:  number;   // 默认 30 000
}

function computeDelayMs(policy: RetryPolicy, attempt: number): number;
```

`computeDelayMs` 计算 `attempt`（从 0 起）的限幅延迟：

| Backoff       | 公式 |
|---------------|------|
| `FIXED`       | `baseDelayMs` |
| `LINEAR`      | `baseDelayMs * (attempt + 1)` |
| `EXPONENTIAL` | `baseDelayMs * 2**attempt` |

结果上限为 `maxDelayMs`。

---

## `TaskContext`

```typescript
interface TaskContext {
  sessionKey?:   string;
  requesterNid?: string;
  traceId?:      string;        // OpenTelemetry 风格的 trace id
}
```

---

## `DagNode` / `DagEdge` / `TaskDag`

```typescript
interface DagNode {
  id:             string;
  action:         string;
  agent:          string;                   // 目标 NID
  inputFrom?:     readonly string[];        // 上游节点 id
  inputMapping?:  Record<string, string>;   // 可选 JSONPath 改写
  timeoutMs?:     number;
  retryPolicy?:   RetryPolicy;
  condition?:     string;                   // JSONPath 风格守卫，如 "$.classify.score > 0.7"
  minRequired?:   number;                   // K-of-N fan-in
}

interface DagEdge {
  from: string;
  to:   string;
}

interface TaskDag {
  nodes: readonly DagNode[];
  edges: readonly DagEdge[];
}
```

按规范：每个 DAG 最多 32 节点、委托链最多 3 层、超时上限
3 600 000 ms（1 小时）。超过上述任一限制将被编排器拒绝（NPS-5 §8.2）。

---

## `TaskFrame` (0x40)

提交 DAG 供执行。

```typescript
class TaskFrame {
  readonly frameType:     FrameType.TASK;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:       string,
    public readonly dag:          TaskDag,
    public readonly timeoutMs?:   number,
    public readonly callbackUrl?: string,    // 编排器做 SSRF 校验
    public readonly context?:     TaskContext,
    public readonly priority?:    TaskPriority,
    public readonly depth?:       number,
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): TaskFrame;
}
```

---

## `DelegateFrame` (0x41)

编排器向每个 agent 发出的逐节点调用。

```typescript
class DelegateFrame {
  readonly frameType:     FrameType.DELEGATE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:         string,
    public readonly subtaskId:      string,
    public readonly action:         string,
    public readonly agentNid:       string,
    public readonly inputs?:        Record<string, unknown>,
    public readonly params?:        Record<string, unknown>,
    public readonly idempotencyKey?: string,
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): DelegateFrame;
}
```

---

## `SyncFrame` (0x42)

Fan-in 屏障 —— 等待 K-of-N 上游子任务。

```typescript
class SyncFrame {
  readonly frameType:     FrameType.SYNC;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:      string,
    public readonly syncId:      string,
    public readonly waitFor:     readonly string[],
    public readonly minRequired: number = 0,    // 0 = waitFor 全部
    public readonly aggregate:   AggregateStrategy | string = "merge",
    public readonly timeoutMs?:  number,
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): SyncFrame;
}
```

`minRequired` 语义：

| 值    | 含义 |
|-------|------|
| `0`   | 等待 `waitFor` 中所有项（严格 fan-in）。 |
| `K`   | 只要 K 个上游子任务完成即继续。 |

---

## `AlignStreamFrame` (0x43)

委托子任务的流式进度 / 部分结果帧。

```typescript
interface StreamError {
  errorCode: string;
  message?:  string;
}

class AlignStreamFrame {
  readonly frameType:     FrameType.ALIGN_STREAM;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly streamId:    string,
    public readonly taskId:      string,
    public readonly subtaskId:   string,
    public readonly seq:         number,
    public readonly isFinal:     boolean,
    public readonly senderNid:   string,
    public readonly data?:       Record<string, unknown>,
    public readonly error?:      StreamError,
    public readonly windowSize?: number,
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): AlignStreamFrame;
}
```

`AlignStreamFrame` 替代已弃用的 `AlignFrame (0x05)` —— 它携带
任务上下文（`taskId` + `subtaskId`）且绑定到特定 `senderNid`。

---

## `NopClient`

NOP 编排器的异步 HTTP 客户端。

```typescript
class NopClient {
  constructor(
    baseUrl: string,
    options?: {
      defaultTier?: EncodingTier;  // 默认 MSGPACK
      registry?:    FrameRegistry; // 默认 NCP + NOP 帧
    },
  );

  async submit(frame: TaskFrame): Promise<string>;              // 返回 taskId
  async getStatus(taskId: string): Promise<NopTaskStatus>;
  async cancel(taskId: string): Promise<void>;
  async wait(
    taskId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<NopTaskStatus>;
}
```

### HTTP 路由

| 方法        | 路径                       |
|-------------|----------------------------|
| `submit`    | `POST /task`               |
| `getStatus` | `GET  /task/{taskId}`      |
| `cancel`    | `POST /task/{taskId}/cancel` |
| `wait`      | 轮询 `getStatus` 直至终态或超时 |

`wait` 默认：`pollIntervalMs = 1000`、`timeoutMs = 30 000`。若截止时间
到达仍未抵达终态则抛 `Error`。

---

## `NopTaskStatus`

编排器 JSON 响应的薄视图。

```typescript
class NopTaskStatus {
  readonly taskId:           string;
  readonly state:            TaskState;
  readonly isTerminal:       boolean;           // COMPLETED | FAILED | CANCELLED
  readonly aggregatedResult: unknown;
  readonly errorCode?:       string;
  readonly errorMessage?:    string;
  readonly nodeResults:      Record<string, unknown>;
  readonly raw:              Record<string, unknown>;
}
```

若需要 `NopTaskStatus` 上没有一等支持的编排器专属字段，`raw` 提供
未经处理的原始 payload。

---

## 端到端示例

```typescript
import {
  NopClient, TaskFrame,
  type TaskDag, BackoffStrategy,
} from "@labacacia/nps-sdk/nop";

const dag: TaskDag = {
  nodes: [
    { id: "fetch",    action: "fetch",    agent: "urn:nps:node:ingest.example.com:http" },
    { id: "classify", action: "classify", agent: "urn:nps:node:ml.example.com:classifier",
      inputFrom: ["fetch"],
      retryPolicy: { maxRetries: 3, backoff: BackoffStrategy.EXPONENTIAL, baseDelayMs: 500 } },
    { id: "route",    action: "route",    agent: "urn:nps:node:ml.example.com:router",
      inputFrom: ["classify"],
      condition: "$.classify.score > 0.7" },
  ],
  edges: [
    { from: "fetch",    to: "classify" },
    { from: "classify", to: "route"    },
  ],
};

const nop     = new NopClient("http://orchestrator.example.com:17433");
const taskId  = await nop.submit(new TaskFrame("job-42", dag, 60_000));
const status  = await nop.wait(taskId, { pollIntervalMs: 500, timeoutMs: 60_000 });

console.log(status.state, status.aggregatedResult);
```
