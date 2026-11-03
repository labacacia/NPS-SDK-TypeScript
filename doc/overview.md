English | [中文版](./overview.cn.md)

# `@labacacia/nps-sdk` — API Reference Overview

[![npm alpha](https://img.shields.io/npm/v/@labacacia/nps-sdk/alpha)](https://www.npmjs.com/package/@labacacia/nps-sdk)

The NPS TypeScript SDK is a dual-format (ESM + CJS) port of the .NET reference
implementation. This document is the entry point for the per-module API
references — each protocol has its own file below.

---

## Package layout

```
@labacacia/nps-sdk
├── /           # root: VERSION, createDefaultRegistry, createFullRegistry
├── /core       # Wire primitives: FrameHeader, codecs, AnchorCache, errors
├── /ncp        # NCP frames + handshake + stream manager
├── /nwp        # NWP frames + async NwpClient
├── /nip        # NIP frames + NipIdentity (Ed25519)
├── /ndp        # NDP frames + InMemoryNdpRegistry + validator
└── /nop        # NOP frames + TaskDag model + NopClient
```

## Reference documents

| Subpath | Module | Reference |
|---------|--------|-----------|
| —                       | Root helpers & registry factories     | this file |
| `@labacacia/nps-sdk/core` | Frame header, codec, anchor cache, exceptions | [`nps-sdk.core.md`](./nps-sdk.core.md) |
| `@labacacia/nps-sdk/ncp`  | NCP frame set (`AnchorFrame`, `DiffFrame`, `StreamFrame`, `CapsFrame`, `ErrorFrame`, `HelloFrame`) | [`nps-sdk.ncp.md`](./nps-sdk.ncp.md) |
| `@labacacia/nps-sdk/nwp`  | `QueryFrame`, `ActionFrame`, `NwpClient` | [`nps-sdk.nwp.md`](./nps-sdk.nwp.md) |
| `@labacacia/nps-sdk/nip`  | `IdentFrame`, `TrustFrame`, `RevokeFrame`, `NipIdentity` | [`nps-sdk.nip.md`](./nps-sdk.nip.md) |
| `@labacacia/nps-sdk/ndp`  | `AnnounceFrame`, `ResolveFrame`, `GraphFrame`, registry, validator | [`nps-sdk.ndp.md`](./nps-sdk.ndp.md) |
| `@labacacia/nps-sdk/nop`  | Task DAG, `TaskFrame`, `DelegateFrame`, `SyncFrame`, `AlignStreamFrame`, `NopClient` | [`nps-sdk.nop.md`](./nps-sdk.nop.md) |

---

## Install

```bash
npm install @labacacia/nps-sdk@alpha
```

Alpha releases are published on the `alpha` dist-tag. The npm `latest` tag is reserved for the default/stable install channel.

Requires **Node.js 18+** (for Web Crypto) or a modern browser with native
`crypto.subtle`.

---

## Root module

```typescript
import { VERSION, createDefaultRegistry, createFullRegistry } from "@labacacia/nps-sdk";
```

- `VERSION` — SDK version constant.
- `createDefaultRegistry()` — new `FrameRegistry` with NCP frames only
  (`ANCHOR`, `DIFF`, `STREAM`, `CAPS`, `ERROR`).
- `createFullRegistry()` — new `FrameRegistry` with all five protocols
  (NCP + NWP + NIP + NDP + NOP) pre-registered. Use this when decoding
  arbitrary frames.

```typescript
const registry = createFullRegistry();
```

---

## Minimal end-to-end example

```typescript
import { NwpClient, QueryFrame, ActionFrame } from "@labacacia/nps-sdk/nwp";

const client = new NwpClient("http://node.example.com:17433");

// Paginated query
const caps = await client.query(
  new QueryFrame("sha256:<anchor-id>", { active: true }, 50),
);
console.log(caps.count, caps.data);

// Streaming query
for await (const chunk of client.stream(new QueryFrame("sha256:<anchor-id>"))) {
  console.log(chunk.seq, chunk.data);
  if (chunk.isLast) break;
}

// Action invocation
const result = await client.invoke(
  new ActionFrame("summarise", { maxTokens: 500 }),
);
```

---

## Encoding tiers

Every frame has a `preferredTier`. MsgPack is the production default; JSON
tier stays available for diagnostics.

| Tier | `EncodingTier` value | Description |
|------|---------------------|-------------|
| Tier-1 JSON    | `0x00` | UTF-8 JSON. Development & compatibility. |
| Tier-2 MsgPack | `0x01` | MessagePack binary. **Production default** — ~60% smaller. |

```typescript
import { EncodingTier } from "@labacacia/nps-sdk/core";
import { NpsFrameCodec } from "@labacacia/nps-sdk/core";

const codec = new NpsFrameCodec(createFullRegistry());
const wire  = codec.encode(frame, { overrideTier: EncodingTier.JSON });
```

---

## Async conventions

- All network-facing clients (`NwpClient`, `NopClient`) return `Promise<T>`.
- Streaming uses `AsyncGenerator<StreamFrame>` — consume with
  `for await (const chunk of …) { … }`.
- Clients do **not** require explicit dispose — the underlying `fetch`
  owns connection lifecycle.

---

## Error hierarchy

```
Error
└── NpsError                       from "@labacacia/nps-sdk/core"
    ├── NpsFrameError              — header parse / structural error
    ├── NpsCodecError              — encode/decode failure
    ├── NpsAnchorNotFoundError     — anchor not in cache
    ├── NpsAnchorPoisonError       — anchor_id / schema mismatch
    └── NpsStreamError             — stream seq gap / unknown stream id
```

`NcpError` (from `@labacacia/nps-sdk/core`) is a separate protocol-level
error carrying a machine-readable `code` (e.g. `NCP-ANCHOR-NOT-FOUND`,
`NCP-STREAM-SEQ-GAP`).

---

## Reference specs

| Module | Spec |
|--------|------|
| `core` + `ncp` | [NPS-1 NCP v0.7](https://github.com/labacacia/NPS/blob/main/spec/NPS-1-NCP.md) |
| `nwp`          | [NPS-2 NWP v0.13](https://github.com/labacacia/NPS/blob/main/spec/NPS-2-NWP.md) |
| `nip`          | [NPS-3 NIP v0.9](https://github.com/labacacia/NPS/blob/main/spec/NPS-3-NIP.md) |
| `ndp`          | [NPS-4 NDP v0.8](https://github.com/labacacia/NPS/blob/main/spec/NPS-4-NDP.md) |
| `nop`          | [NPS-5 NOP v0.6](https://github.com/labacacia/NPS/blob/main/spec/NPS-5-NOP.md) |
