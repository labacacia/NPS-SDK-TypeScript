English | [中文版](./nps-sdk.ndp.cn.md)

# `@labacacia/nps-sdk/ndp` — Class and Method Reference

> Spec: [NPS-4 NDP v0.8](https://github.com/labacacia/NPS/blob/main/spec/NPS-4-NDP.md)

NDP is the discovery layer — the NPS analogue of DNS. This module provides
the three NDP frame types, a thread-safe in-memory registry with lazy
TTL eviction, and an announce-signature validator.

---

## Table of contents

- [Supporting interfaces](#supporting-interfaces)
- [`AnnounceFrame` (0x30)](#announceframe-0x30)
- [`ResolveFrame` (0x31)](#resolveframe-0x31)
- [`GraphFrame` (0x32)](#graphframe-0x32)
- [`InMemoryNdpRegistry`](#inmemoryndpregistry)
- [`NdpAnnounceValidator`](#ndpannouncevalidator)
- [`NdpAnnounceResult`](#ndpannounceresult)

---

## Supporting interfaces

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
  ttl:              number;                // seconds
  certFingerprint?: string;                // "sha256:{hex}"
}
```

---

## `AnnounceFrame` (0x30)

Publishes a node's physical reachability and TTL (NPS-4 §3.1).

```typescript
class AnnounceFrame {
  readonly frameType:     FrameType.ANNOUNCE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:          string,
    public readonly addresses:    readonly NdpAddress[],
    public readonly capabilities: readonly string[],
    public readonly ttl:          number,          // 0 = orderly shutdown
    public readonly timestamp:    string,          // ISO 8601 UTC
    public readonly signature:    string,          // "ed25519:{base64}"
    public readonly nodeType?:    string,
  );

  unsignedDict(): Record<string, unknown>;   // signing payload (no signature)
  toDict():        Record<string, unknown>;

  static fromDict(data: Record<string, unknown>): AnnounceFrame;
}
```

Signing workflow:

1. Call `frame.unsignedDict()` — this strips `signature`.
2. Sign with `NipIdentity.sign(dict)` using the NID's own private key
   (the same key backing its `IdentFrame`).
3. Publishing `ttl = 0` MUST be done before orderly shutdown so that
   subscribers evict the entry.

---

## `ResolveFrame` (0x31)

Request / response envelope for resolving an `nwp://` URL.

```typescript
class ResolveFrame {
  readonly frameType:     FrameType.RESOLVE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly target:        string,           // "nwp://api.example.com/products"
    public readonly requesterNid?: string,
    public readonly resolved?:     NdpResolveResult, // populated on response
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): ResolveFrame;
}
```

JSON tier is preferred for resolve traffic — it's low-volume and
human-debugged.

---

## `GraphFrame` (0x32)

Topology sync between registries.

```typescript
class GraphFrame {
  readonly frameType:     FrameType.GRAPH;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly seq:         number,                   // strictly monotonic per publisher
    public readonly initialSync: boolean,
    public readonly nodes?:      readonly NdpGraphNode[],  // full snapshot
    public readonly patch?:      readonly Record<string, unknown>[], // RFC 6902 JSON Patch
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): GraphFrame;
}
```

Gaps in `seq` MUST trigger a re-sync request signalled with
`NDP-GRAPH-SEQ-GAP`.

---

## `InMemoryNdpRegistry`

Thread-safe, TTL-evicting registry. Expiry is evaluated **lazily** on
every read — there is no background timer.

```typescript
class InMemoryNdpRegistry {
  // Replaceable for deterministic tests
  clock: () => number;

  announce(frame: AnnounceFrame): void;
  getByNid(nid: string): AnnounceFrame | undefined;
  resolve(target: string): NdpResolveResult | undefined;
  getAll(): AnnounceFrame[];

  static nwpTargetMatchesNid(nid: string, target: string): boolean;
}
```

### Behaviour

- `announce` with `ttl === 0` immediately evicts the NID; otherwise the
  entry is inserted / refreshed with absolute expiry `clock() + ttl*1000`.
- `resolve` scans live entries for the first NID covering `target` and
  returns its first advertised address wrapped in `NdpResolveResult`.
- `getByNid` does exact NID lookup with on-demand purge.
- Override `clock` in tests: `registry.clock = () => 1000_000;`

### `nwpTargetMatchesNid(nid, target)` *(static)*

The NID ↔ target covering rule:

```
NID:    urn:nps:node:{authority}:{name}
Target: nwp://{authority}/{name}[/subpath]
```

A node NID covers a target when:

1. The target scheme is `nwp://`.
2. The NID authority equals the target authority (exact, case-sensitive).
3. The target path equals `{name}` or starts with `{name}/`.

Returns `false` for malformed inputs rather than throwing.

---

## `NdpAnnounceValidator`

Verifies an `AnnounceFrame.signature` using a registered Ed25519 public
key.

```typescript
class NdpAnnounceValidator {
  registerPublicKey(nid: string, encodedPubKey: string): void;
  removePublicKey(nid: string): void;

  readonly knownPublicKeys: ReadonlyMap<string, string>;

  validate(frame: AnnounceFrame): NdpAnnounceResult;
}
```

`validate` (NPS-4 §7.1):

1. Looks up `frame.nid` in the registered keys. Missing →
   `NdpAnnounceResult.fail("NDP-ANNOUNCE-NID-MISMATCH", …)`. Expected
   workflow: verify the announcer's `IdentFrame` first, then register
   its `pubKeyString` here.
2. Rebuilds the signing payload from `frame.unsignedDict()` using the
   sorted-keys canonical form.
3. Runs Ed25519 verify.
4. Returns `NdpAnnounceResult.ok()` on success, or
   `NdpAnnounceResult.fail("NDP-ANNOUNCE-SIG-INVALID", …)` on failure.

The encoded key MUST use the `ed25519:{hex}` form produced by
`NipIdentity.pubKeyString`.

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

## End-to-end example

```typescript
import { NipIdentity } from "@labacacia/nps-sdk/nip";
import {
  AnnounceFrame, InMemoryNdpRegistry, NdpAnnounceValidator,
} from "@labacacia/nps-sdk/ndp";

const id  = NipIdentity.generate();
const nid = "urn:nps:node:api.example.com:products";

// Build & sign the announce
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

// Validate + register
const validator = new NdpAnnounceValidator();
validator.registerPublicKey(nid, id.pubKeyString);
const result = validator.validate(signed);
if (!result.isValid) throw new Error(result.errorCode);

const registry = new InMemoryNdpRegistry();
registry.announce(signed);

const resolved = registry.resolve("nwp://api.example.com/products/items/42");
// → { host: "10.0.0.5", port: 17433, ttl: 300 }
```
