English | [中文版](./nps-sdk.ncp.cn.md)

# `@labacacia/nps-sdk/ncp` — Class and Method Reference

> Spec: [NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.md)

NCP is the wire-and-schema layer. This module provides the five core frames
(`AnchorFrame`, `DiffFrame`, `StreamFrame`, `CapsFrame`, `ErrorFrame`) plus
the native-mode handshake helpers (`HelloFrame`) and the stream manager used
by receivers to reassemble chunked streams.

---

## Table of contents

- [`AnchorFrame` (0x01)](#anchorframe-0x01)
- [`DiffFrame` (0x02)](#diffframe-0x02)
- [`StreamFrame` (0x03)](#streamframe-0x03)
- [`CapsFrame` (0x04)](#capsframe-0x04)
- [`HelloFrame` (0x06)](#helloframe-0x06)
- [`ErrorFrame` (0xFE)](#errorframe-0xfe)
- [Handshake helpers](#handshake-helpers)
- [`StreamManager`](#streammanager)
- [`NCP_ERROR_CODES`](#ncp_error_codes)

---

## `AnchorFrame` (0x01)

Schema anchor — content-addressed schema advertisement.

```typescript
interface SchemaField {
  name:      string;
  type:      string;      // "string" | "uint64" | "int64" | "decimal" |
                          // "bool"   | "timestamp" | "bytes" | "object" | "array"
  semantic?: string;      // optional NPS semantic tag
  nullable?: boolean;
}

interface FrameSchema {
  fields: SchemaField[];
}

interface AnchorFrame {
  frame:     "0x01";
  anchor_id: string;      // "sha256:{64 lowercase hex}"
  schema:    FrameSchema;
  ttl?:      number;      // seconds; 0 = session-only
}

function computeAnchorId(schema: FrameSchema): string;
function validateAnchorFrame(frame: AnchorFrame): void;
```

`computeAnchorId` canonicalises the schema via RFC 8785 JCS, hashes with
SHA-256 and returns `"sha256:{hex}"`.

`validateAnchorFrame` raises `NcpError("NCP-ANCHOR-SCHEMA-INVALID")` when:
- a field has an unknown `type`, OR
- `anchor_id` does not match the computed canonical hash.

---

## `DiffFrame` (0x02)

Incremental data patch anchored to a prior `AnchorFrame`.

```typescript
interface JsonPatchOperation {
  op:    "add" | "remove" | "replace" | "move" | "copy" | "test";
  path:  string;       // JSON Pointer
  value?: unknown;
  from?: string;       // for move/copy
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

- `validateDiffSeq` throws `NcpError("NCP-STREAM-SEQ-GAP")` if
  `base_seq !== currentSeq`.
- `validateDiffFrame` throws `NcpError("NCP-DIFF-FORMAT-UNSUPPORTED")`
  on unknown `patch_format`, or when `binary_bitset` is used on a
  non-Tier-2 MsgPack frame.

---

## `StreamFrame` (0x03)

Streaming chunk frame.

```typescript
interface StreamFrame {
  frame:        "0x03";
  stream_id:    string;       // UUID v4
  seq:          number;
  is_last:      boolean;
  anchor_ref?:  string;
  data:         unknown[];
  window_size?: number;       // back-pressure hint
  error_code?:  string;       // terminal error — implies is_last=true
}

function validateStreamFrame(frame: StreamFrame): void;
```

`stream_id` must match the UUID-v4 shape, otherwise
`NcpError("NPS-CLIENT-BAD-FRAME")` is raised.

---

## `CapsFrame` (0x04)

Capsule — a complete result page that references a cached schema.

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

`validateCapsFrame` enforces:
- `count === data.length` — otherwise `NpsStatusCodes.NPS_CLIENT_BAD_FRAME`.
- If `inline_anchor` is present, `inline_anchor.anchor_id` matches the
  canonical hash of `inline_anchor.schema` — otherwise
  `NcpError("NCP-ANCHOR-SCHEMA-INVALID")`.

---

## `HelloFrame` (0x06)

Native-mode client handshake (NPS-1 §4.6).

```typescript
interface HelloFrame {
  frame:                   "0x06";
  nps_version:             string;
  min_version?:            string;
  supported_encodings:     string[];   // non-empty
  supported_protocols:     string[];   // non-empty
  agent_id?:               string;
  max_frame_payload?:      number;
  ext_support?:            boolean;
  max_concurrent_streams?: number;
  e2e_enc_algorithms?:     string[];
}

function validateHelloFrame(frame: HelloFrame): void;
```

`validateHelloFrame` checks that the three required fields are present and
the two array fields are non-empty.

---

## `ErrorFrame` (0xFE)

Unified error frame shared by every NPS protocol layer (NPS-0 §9).

```typescript
interface ErrorFrame {
  frame:    "0xFE";
  status:   string;            // NPS status code, e.g. "NPS-CLIENT-NOT-FOUND"
  error:    string;            // protocol code, e.g. "NCP-ANCHOR-NOT-FOUND"
  message?: string;
  details?: Record<string, unknown>;
}

function isErrorFrame(obj: unknown): obj is ErrorFrame;
```

Use `isErrorFrame` as a type guard on decoded payloads.

---

## Handshake helpers

Version & encoding negotiation for native mode (NPS-1 §2.6).

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

- Version comparison is component-wise numeric — `"0.9" < "0.10" < "1.0"`.
- `negotiateEncoding` returns `"msgpack"` when both sides advertise it,
  falling back to `"json"`, then the first mutual entry in the client's
  preference order.

---

## `StreamManager`

Tracks concurrent `StreamFrame` streams, enforces sequence ordering and
flow-control windows.

```typescript
class StreamManager {
  constructor(options?: { maxConcurrent?: number });  // default 32

  receive(frame: StreamFrame): boolean;       // true when stream is complete
  send(frame: StreamFrame): void;             // enforces outgoing window
  updateWindow(streamId: string, newSize: number): void;
  isPaused(streamId: string): boolean;

  getData(streamId: string): unknown[] | null;   // flattened chunks after completion
  getError(streamId: string): string | undefined;
  readonly activeCount: number;
}
```

### Failure modes

| Condition | Thrown |
|-----------|--------|
| `seq !== 0` on an unknown stream | `NcpError("NCP-STREAM-NOT-FOUND")` |
| Too many concurrent streams open | `NcpError("NCP-STREAM-LIMIT-EXCEEDED")` |
| Writing to a stream already completed | `NcpError("NPS-CLIENT-CONFLICT")` |
| `seq` gap in received order | `NcpError("NCP-STREAM-SEQ-GAP")` |
| Outgoing window exhausted | `NcpError("NCP-STREAM-WINDOW-OVERFLOW")` |

Duplicate frames with a `seq` lower than `expectedSeq` are silently
ignored (idempotent).

---

## `NCP_ERROR_CODES`

Constant bundle of NCP-layer protocol codes (NPS-1 §6, §7.4).

```typescript
import { NCP_ERROR_CODES } from "@labacacia/nps-sdk/ncp";

NCP_ERROR_CODES.NCP_ANCHOR_NOT_FOUND;     // "NCP-ANCHOR-NOT-FOUND"
NCP_ERROR_CODES.NCP_STREAM_SEQ_GAP;       // "NCP-STREAM-SEQ-GAP"
NCP_ERROR_CODES.NCP_VERSION_INCOMPATIBLE; // "NCP-VERSION-INCOMPATIBLE"
// …
```

`NCP_FRAME_PARSE_ERROR` and `NCP_FRAME_INCOMPLETE` are implementation-only
codes not defined in the spec § 6; everything else is spec-canonical.
