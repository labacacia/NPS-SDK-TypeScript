English | [中文版](./nps-sdk.nip.cn.md)

# `@labacacia/nps-sdk/nip` — Class and Method Reference

> Spec: [NPS-3 NIP v0.9](https://github.com/labacacia/NPS/blob/main/spec/NPS-3-NIP.md)

NIP is the TLS/PKI of NPS. This module exposes the three identity frames
(`IdentFrame`, `TrustFrame`, `RevokeFrame`), the metadata interface, and
the `NipIdentity` helper that owns an Ed25519 keypair with optional
AES-256-GCM + PBKDF2-SHA256 key-file encryption.

---

## Table of contents

- [`IdentMetadata`](#identmetadata)
- [`IdentFrame` (0x20)](#identframe-0x20)
- [`TrustFrame` (0x21)](#trustframe-0x21)
- [`RevokeFrame` (0x22)](#revokeframe-0x22)
- [`NipIdentity`](#nipidentity)
- [Canonical JSON & signing format](#canonical-json--signing-format)
- [`NipErrorCodes`](#niperrorecodes)

---

## `IdentMetadata`

```typescript
interface IdentMetadata {
  issuer:        string;
  issuedAt:      string;
  expiresAt?:    string;
  capabilities?: readonly string[];
  scopes?:       readonly string[];
}
```

Attached to `IdentFrame.metadata`. Excluded from the signed payload
produced by `unsignedDict()` — metadata is runtime-mutable and not part
of the agent's identity.

---

## `IdentFrame` (0x20)

Agent identity certificate. Sent as the opening frame on any
authenticated session.

```typescript
class IdentFrame {
  readonly frameType:     FrameType.IDENT;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:       string,      // urn:nps:agent:{authority}:{name}
    public readonly pubKey:    string,      // "ed25519:{hex}"
    public readonly metadata:  IdentMetadata,
    public readonly signature: string,      // "ed25519:{base64}"
  );

  unsignedDict(): Record<string, unknown>;   // { nid, pub_key, metadata } — signing payload
  toDict():        Record<string, unknown>;   // unsignedDict + signature

  static fromDict(data: Record<string, unknown>): IdentFrame;
}
```

`unsignedDict()` is the canonical signing payload — it omits the
`signature` field. Pair it with `NipIdentity.sign()` to produce the
self-signed `signature`.

---

## `TrustFrame` (0x21)

Inter-CA trust certificate.

```typescript
class TrustFrame {
  readonly frameType:     FrameType.TRUST;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly issuerNid:  string,
    public readonly subjectNid: string,
    public readonly scopes:     readonly string[],
    public readonly expiresAt:  string,      // ISO 8601 UTC
    public readonly signature:  string,      // "ed25519:{base64}"
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): TrustFrame;
}
```

---

## `RevokeFrame` (0x22)

Certificate revocation.

```typescript
class RevokeFrame {
  readonly frameType:     FrameType.REVOKE;
  readonly preferredTier: EncodingTier.MSGPACK;

  constructor(
    public readonly nid:        string,
    public readonly reason?:    string,     // e.g. "key_compromise"
    public readonly revokedAt?: string,     // ISO 8601 UTC
  );

  toDict(): Record<string, unknown>;
  static fromDict(data: Record<string, unknown>): RevokeFrame;
}
```

Signed by the issuing CA. Verifiers MUST refuse any `IdentFrame` whose
`nid` is covered by a valid `RevokeFrame`.

---

## `NipIdentity`

Ed25519 keypair manager with optional encrypted-keyfile persistence.
Built on `@noble/ed25519` + `node:crypto`.

```typescript
class NipIdentity {
  // Factory
  static generate(): NipIdentity;
  static fromPrivateKey(privKey: Uint8Array): NipIdentity;
  static load(path: string, passphrase: string): NipIdentity;

  // Persist
  save(path: string, passphrase: string): void;

  // Signing
  sign(payload: Record<string, unknown>): string;            // "ed25519:{base64}"
  verify(payload: Record<string, unknown>, signature: string): boolean;

  // Public key access
  readonly pubKey:        Uint8Array;          // 32 bytes
  readonly pubKeyString:  string;              // "ed25519:{hex}"
}
```

### Key-file format

`save` / `load` write a JSON envelope (versioned) containing:

```
{
  version:    1,
  salt:       hex(16 B),
  iv:         hex(12 B),
  ciphertext: hex( AES-GCM(privateKey) || authTag(16 B) ),
  pubKey:     hex(32 B)
}
```

Key derivation: **PBKDF2-SHA256**, 600 000 iterations.
Cipher: **AES-256-GCM** — the 16-byte auth tag is appended to the
ciphertext inside the `ciphertext` field.

### `generate()`

Produces a fresh Ed25519 keypair. Does not touch disk.

### `fromPrivateKey(priv)`

Wraps an existing 32-byte Ed25519 private key (derives the matching
public key).

### `load(path, passphrase)`

Reads & decrypts a previously saved keyfile. Throws if the JSON envelope
is malformed, if the auth tag is invalid, or if the passphrase is wrong.

### `save(path, passphrase)`

Encrypts and writes the keypair to `path`. The file is overwritten if it
exists — back up first.

### `sign(payload)` / `verify(payload, signature)`

Canonicalises `payload` (sorted keys, compact separators), runs Ed25519,
and emits `"ed25519:{base64}"`. `verify` returns `false` on any failure —
it never throws.

---

## Canonical JSON & signing format

The SDK normalises signing payloads with:

```js
JSON.stringify(payload, Object.keys(payload).sort());
```

- Keys are sorted lexicographically at every level.
- `undefined` keys are dropped implicitly by `JSON.stringify`.
- No whitespace between tokens.
- Output UTF-8 bytes feed the Ed25519 primitive.

For `IdentFrame`, use `unsignedDict()` as the payload — it already omits
`signature`.

---

## End-to-end example

```typescript
import {
  IdentFrame, IdentMetadata, NipIdentity,
} from "@labacacia/nps-sdk/nip";

// 1) One-off: create a keypair and persist it
const id = NipIdentity.generate();
id.save("./agent.key", "correct horse battery");

// 2) Build & sign an IdentFrame
const meta: IdentMetadata = {
  issuer:    "urn:nps:ca:example.com:root",
  issuedAt:  new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  capabilities: ["nwp:query", "nop:delegate"],
};

const unsigned = new IdentFrame(
  "urn:nps:agent:example.com:agent-001",
  id.pubKeyString,
  meta,
  "placeholder",
);

const signature = id.sign(unsigned.unsignedDict());
const signed    = new IdentFrame(unsigned.nid, unsigned.pubKey, meta, signature);

// 3) Anyone with the same keypair (or equivalent pubKey) can verify
const ok = id.verify(signed.unsignedDict(), signed.signature);
// → true
```

---

## `NipErrorCodes`

String constants for NIP wire error codes. Import from `@labacacia/nps-sdk/nip`.

```typescript
import { NipErrorCodes } from "@labacacia/nps-sdk/nip";
```

| Constant | Wire value | Since |
|----------|------------|-------|
| `NipErrorCodes.IDENT_SIG_INVALID` | `"NIP-IDENT-SIG-INVALID"` | alpha.4 |
| `NipErrorCodes.IDENT_NID_MISMATCH` | `"NIP-IDENT-NID-MISMATCH"` | alpha.4 |
| `NipErrorCodes.IDENT_EXPIRED` | `"NIP-IDENT-EXPIRED"` | alpha.4 |
| `NipErrorCodes.IDENT_REVOKED` | `"NIP-IDENT-REVOKED"` | alpha.4 |
| `NipErrorCodes.TRUST_CHAIN_BROKEN` | `"NIP-TRUST-CHAIN-BROKEN"` | alpha.4 |
| `NipErrorCodes.TRUST_SCOPE_VIOLATION` | `"NIP-TRUST-SCOPE-VIOLATION"` | alpha.4 |
| `NipErrorCodes.ACME_CHALLENGE_FAILED` | `"NIP-ACME-CHALLENGE-FAILED"` | alpha.4 |
| `NipErrorCodes.ACME_ORDER_EXPIRED` | `"NIP-ACME-ORDER-EXPIRED"` | alpha.4 |
| `NipErrorCodes.X509_CERT_INVALID` | `"NIP-X509-CERT-INVALID"` | alpha.4 |
| `NipErrorCodes.X509_CHAIN_UNTRUSTED` | `"NIP-X509-CHAIN-UNTRUSTED"` | alpha.4 |
| `NipErrorCodes.REPUTATION_LOG_UNREACHABLE` | `"NIP-REPUTATION-LOG-UNREACHABLE"` | alpha.4 |
| `NipErrorCodes.REPUTATION_GOSSIP_FORK` | `"NIP-REPUTATION-GOSSIP-FORK"` | **alpha.5** |
| `NipErrorCodes.REPUTATION_GOSSIP_SIG_INVALID` | `"NIP-REPUTATION-GOSSIP-SIG-INVALID"` | **alpha.5** |

`REPUTATION_GOSSIP_FORK` is returned when an STH consistency check fails across peers.
`REPUTATION_GOSSIP_SIG_INVALID` is returned when a peer STH signature fails verification during a gossip exchange.
