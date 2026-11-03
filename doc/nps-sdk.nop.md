English | [中文版](./nps-sdk.nop.cn.md)

# `@labacacia/nps-sdk/nop` — Class and Method Reference

> Spec: [NPS-5 NOP v0.6](https://github.com/labacacia/NPS/blob/main/spec/NPS-5-NOP.md)

NOP is the orchestration layer — submit a DAG of delegated subtasks, wait
for completion, stream results back. This module ships the four NOP
frames (0x40–0x43), the task model (`TaskDag`, `DagNode`, `DagEdge`,
`RetryPolicy`, `TaskContext`), and the async `NopClient` + `NopTaskStatus`.

---

## Table of contents

- [Enums & constants](#enums--constants)
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

## Enums & constants

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

Terminal states are `COMPLETED`, `FAILED`, `CANCELLED`. `NopTaskStatus.isTerminal`
uses this set.

---

## `RetryPolicy`

```typescript
interface RetryPolicy {
  maxRetries:   number;
  backoff:      BackoffStrategy;
  baseDelayMs?: number;   // default 1 000
  maxDelayMs?:  number;   // default 30 000
}

function computeDelayMs(policy: RetryPolicy, attempt: number): number;
```

`computeDelayMs` computes the clamped delay for `attempt` (0-indexed):

| Backoff       | Formula |
|---------------|---------|
| `FIXED`       | `baseDelayMs` |
| `LINEAR`      | `baseDelayMs * (attempt + 1)` |
| `EXPONENTIAL` | `baseDelayMs * 2**attempt` |

The result is capped at `maxDelayMs`.

---

## `TaskContext`

```typescript
interface TaskContext {
  sessionKey?:   string;
  requesterNid?: string;
  traceId?:      string;        // OpenTelemetry-shaped trace id
}
```

---

## `DagNode` / `DagEdge` / `TaskDag`

```typescript
interface DagNode {
  id:             string;
  action:         string;
  agent:          string;                   // target NID
  inputFrom?:     readonly string[];        // upstream node ids
  inputMapping?:  Record<string, string>;   // optional JSONPath rewrites
  timeoutMs?:     number;
  retryPolicy?:   RetryPolicy;
  condition?:     string;                   // JSONPath-style guard, e.g. "$.classify.score > 0.7"
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

Per the spec: max 32 nodes per DAG, max 3 levels of delegate chain, max
timeout 3 600 000 ms (1 h). Exceeding any of those limits is rejected by
the orchestrator (NPS-5 §8.2).

---

## `TaskFrame` (0x40)

Submit a DAG for execution.

```typescript
class TaskFrame {
  readonly frameType:     FrameType.TASK;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:       string,
    public readonly dag:          TaskDag,
    public readonly timeoutMs?:   number,
    public readonly callbackUrl?: string,    // SSRF-validated by the orchestrator
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

Per-node invocation emitted by the orchestrator to each agent.

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

Fan-in barrier — waits for K-of-N upstream subtasks.

```typescript
class SyncFrame {
  readonly frameType:     FrameType.SYNC;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly taskId:      string,
    public readonly syncId:      string,
    public readonly waitFor:     readonly string[],
    public readonly minRequired: number = 0,    // 0 = all of waitFor
    public readonly aggregate:   AggregateStrategy | string = "merge",
    public readonly timeoutMs?:  number,
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): SyncFrame;
}
```

`minRequired` semantics:

| Value | Meaning |
|-------|---------|
| `0`   | Wait for all of `waitFor` (strict fan-in). |
| `K`   | Proceed as soon as K upstream subtasks have completed. |

---

## `AlignStreamFrame` (0x43)

Streaming progress / partial result frame for a delegated subtask.

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

`AlignStreamFrame` replaces the deprecated `AlignFrame (0x05)` — it
carries task context (`taskId` + `subtaskId`) and is bound to a specific
`senderNid`.

---

## `NopClient`

Async HTTP client for an NOP orchestrator.

```typescript
class NopClient {
  constructor(
    baseUrl: string,
    options?: {
      defaultTier?: EncodingTier;  // default MSGPACK
      registry?:    FrameRegistry; // default NCP + NOP frames
    },
  );

  async submit(frame: TaskFrame): Promise<string>;              // returns taskId
  async getStatus(taskId: string): Promise<NopTaskStatus>;
  async cancel(taskId: string): Promise<void>;
  async wait(
    taskId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<NopTaskStatus>;
}
```

### HTTP routes

| Method      | Path                       |
|-------------|----------------------------|
| `submit`    | `POST /task`               |
| `getStatus` | `GET  /task/{taskId}`      |
| `cancel`    | `POST /task/{taskId}/cancel` |
| `wait`      | polls `getStatus` until terminal or timeout |

`wait` defaults: `pollIntervalMs = 1000`, `timeoutMs = 30 000`. It throws
an `Error` when the deadline expires without reaching a terminal state.

---

## `NopTaskStatus`

Thin view over the orchestrator's JSON response.

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

`raw` gives you the untouched payload if you need orchestrator-specific
fields that aren't first-class on `NopTaskStatus`.

---

## End-to-end example

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
