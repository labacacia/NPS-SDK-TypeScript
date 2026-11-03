[English Version](./nps-sdk.ncp.md) | 中文版

# `@labacacia/nps-sdk/ncp` — 类与方法参考

> 规范：[NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.md)

NCP 是线路与 schema 层。本模块提供五个核心帧
（`AnchorFrame`、`DiffFrame`、`StreamFrame`、`CapsFrame`、`ErrorFrame`），
以及原生模式握手辅助（`HelloFrame`）和接收方用于重组分块流的 stream manager。

---

## 目录

- [`AnchorFrame` (0x01)](#anchorframe-0x01)
- [`DiffFrame` (0x02)](#diffframe-0x02)
- [`StreamFrame` (0x03)](#streamframe-0x03)
- [`CapsFrame` (0x04)](#capsframe-0x04)
- [`HelloFrame` (0x06)](#helloframe-0x06)
- [`ErrorFrame` (0xFE)](#errorframe-0xfe)
- [握手辅助](#握手辅助)
- [`StreamManager`](#streammanager)
- [`NCP_ERROR_CODES`](#ncp_error_codes)

---

## `AnchorFrame` (0x01)

Schema 锚点 —— 内容寻址的 schema 广告。

```typescript
interface SchemaField {
  name:      string;
  type:      string;      // "string" | "uint64" | "int64" | "decimal" |
                          // "bool"   | "timestamp" | "bytes" | "object" | "array"
  semantic?: string;      // 可选的 NPS 语义标签
  nullable?: boolean;
}

interface FrameSchema {
  fields: SchemaField[];
}

interface AnchorFrame {
  frame:     "0x01";
  anchor_id: string;      // "sha256:{64 位小写 hex}"
  schema:    FrameSchema;
  ttl?:      number;      // 秒；0 = 仅 session
}

function computeAnchorId(schema: FrameSchema): string;
function validateAnchorFrame(frame: AnchorFrame): void;
```

`computeAnchorId` 通过 RFC 8785 JCS 规范化 schema，用 SHA-256 哈希，
返回 `"sha256:{hex}"`。

`validateAnchorFrame` 在以下情况抛 `NcpError("NCP-ANCHOR-SCHEMA-INVALID")`：
- 字段拥有未知的 `type`，或
- `anchor_id` 与计算出的规范哈希不匹配。

---

## `DiffFrame` (0x02)

锚定到之前某个 `AnchorFrame` 的增量数据补丁。

```typescript
interface JsonPatchOperation {
  op:    "add" | "remove" | "replace" | "move" | "copy" | "test";
  path:  string;       // JSON Pointer
  value?: unknown;
  from?: string;       // 用于 move/copy
}

type PatchFormat = "json_patch" | "binary_bitset";

interface DiffFrame {
  frame:         "0x02";
  anchor_ref:    string;
  base_seq:      number;
  patch_format?: PatchFormat;
  patch:         JsonPatchOperation[] | Uint8Array;
  entity_id?:    string;
}

function validateDiffSeq(frame: DiffFrame, currentSeq: number): void;
function validateDiffFrame(frame: DiffFrame, encodingTier: EncodingTier): void;
```

- 若 `base_seq !== currentSeq`，`validateDiffSeq` 抛
  `NcpError("NCP-STREAM-SEQ-GAP")`。
- 当 `patch_format` 未知，或在非 Tier-2 MsgPack 帧上使用 `binary_bitset` 时，
  `validateDiffFrame` 抛 `NcpError("NCP-DIFF-FORMAT-UNSUPPORTED")`。

---

## `StreamFrame` (0x03)

流式分块帧。

```typescript
interface StreamFrame {
  frame:        "0x03";
  stream_id:    string;       // UUID v4
  seq:          number;
  is_last:      boolean;
  anchor_ref?:  string;
  data:         unknown[];
  window_size?: number;       // 反压提示
  error_code?:  string;       // 终止错误 —— 隐含 is_last=true
}

function validateStreamFrame(frame: StreamFrame): void;
```

`stream_id` 必须匹配 UUID-v4 形状，否则抛
`NcpError("NPS-CLIENT-BAD-FRAME")`。

---

## `CapsFrame` (0x04)

胶囊 —— 引用某个已缓存 schema 的完整结果页。

```typescript
interface CapsFrameInlineAnchor {
  anchor_id: string;
  schema:    FrameSchema;
  ttl?:      number;
}

interface CapsFrame {
  frame:           "0x04";
  anchor_ref:      string;
  count:           number;
  data:            unknown[];
  next_cursor?:    string | null;
  token_est?:      number;
  tokenizer_used?: string;
  cached?:         boolean;
  inline_anchor?:  CapsFrameInlineAnchor;
}

function validateCapsFrame(frame: CapsFrame): void;
```

`validateCapsFrame` 强制：
- `count === data.length` —— 否则 `NpsStatusCodes.NPS_CLIENT_BAD_FRAME`。
- 若 `inline_anchor` 存在，`inline_anchor.anchor_id` 必须与
  `inline_anchor.schema` 的规范哈希匹配 —— 否则
  `NcpError("NCP-ANCHOR-SCHEMA-INVALID")`。

---

## `HelloFrame` (0x06)

原生模式客户端握手（NPS-1 §4.6）。

```typescript
interface HelloFrame {
  frame:                   "0x06";
  nps_version:             string;
  min_version?:            string;
  supported_encodings:     string[];   // 非空
  supported_protocols:     string[];   // 非空
  agent_id?:               string;
  max_frame_payload?:      number;
  ext_support?:            boolean;
  max_concurrent_streams?: number;
  e2e_enc_algorithms?:     string[];
}

function validateHelloFrame(frame: HelloFrame): void;
```

`validateHelloFrame` 检查三个必填字段存在且两个数组字段非空。

---

## `ErrorFrame` (0xFE)

所有 NPS 协议层共用的统一错误帧（NPS-0 §9）。

```typescript
interface ErrorFrame {
  frame:    "0xFE";
  status:   string;            // NPS 状态码，如 "NPS-CLIENT-NOT-FOUND"
  error:    string;            // 协议码，如 "NCP-ANCHOR-NOT-FOUND"
  message?: string;
  details?: Record<string, unknown>;
}

function isErrorFrame(obj: unknown): obj is ErrorFrame;
```

在解码后的 payload 上把 `isErrorFrame` 用作类型 guard。

---

## 握手辅助

原生模式的版本与编码协商（NPS-1 §2.6）。

```typescript
function negotiateVersion(
  client: { nps_version: string; min_version?: string },
  server: { nps_version: string },
): { session_version: string; compatible: boolean; error_code?: string };

function negotiateEncoding(
  client: string[],
  server: string[],
): { encoding: string | null };
```

- 版本比较按分量数字进行 —— `"0.9" < "0.10" < "1.0"`。
- 当双方都广告 `"msgpack"` 时 `negotiateEncoding` 返回它，
  否则降级到 `"json"`，再否则按客户端偏好顺序选择第一个共有项。

---

## `StreamManager`

追踪并发 `StreamFrame` 流，强制顺序与流控窗口。

```typescript
class StreamManager {
  constructor(options?: { maxConcurrent?: number });  // 默认 32

  receive(frame: StreamFrame): boolean;       // 流完成时返回 true
  send(frame: StreamFrame): void;             // 强制发出窗口
  updateWindow(streamId: string, newSize: number): void;
  isPaused(streamId: string): boolean;

  getData(streamId: string): unknown[] | null;   // 完成后扁平化分块
  getError(streamId: string): string | undefined;
  readonly activeCount: number;
}
```

### 失败模式

| 条件 | 抛出 |
|------|------|
| 未知流上 `seq !== 0` | `NcpError("NCP-STREAM-NOT-FOUND")` |
| 并发流过多 | `NcpError("NCP-STREAM-LIMIT-EXCEEDED")` |
| 写入已完成的流 | `NcpError("NPS-CLIENT-CONFLICT")` |
| 接收顺序中的 `seq` 跳号 | `NcpError("NCP-STREAM-SEQ-GAP")` |
| 发送窗口耗尽 | `NcpError("NCP-STREAM-WINDOW-OVERFLOW")` |

`seq` 小于 `expectedSeq` 的重复帧被静默忽略（幂等）。

---

## `NCP_ERROR_CODES`

NCP 层协议码常量包（NPS-1 §6、§7.4）。

```typescript
import { NCP_ERROR_CODES } from "@labacacia/nps-sdk/ncp";

NCP_ERROR_CODES.NCP_ANCHOR_NOT_FOUND;     // "NCP-ANCHOR-NOT-FOUND"
NCP_ERROR_CODES.NCP_STREAM_SEQ_GAP;       // "NCP-STREAM-SEQ-GAP"
NCP_ERROR_CODES.NCP_VERSION_INCOMPATIBLE; // "NCP-VERSION-INCOMPATIBLE"
// …
```

`NCP_FRAME_PARSE_ERROR` 和 `NCP_FRAME_INCOMPLETE` 为规范 §6 未定义的
实现专属码；其余均为规范标准。
